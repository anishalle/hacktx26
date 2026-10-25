// Feature 2: pre-send clarity nudge. State machine for the composer, following docs/API.md:
// debounced /nudge/check → banner (Rewrite / Keep mine); on send with newcomers → /nudge/unknown
// (3 s timeout) → "Send anyway" / Add aside → /nudge/aside. Never blocks a send otherwise.
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useRef, useState } from 'react';

import { api, type NudgeCheck, type NudgeUnknown, type Span } from '@/api';

const CHECK_DEBOUNCE_MS = 800;
const UNKNOWN_TIMEOUT_MS = 3000;

export type NudgeBannerState =
  | { kind: 'check'; data: NudgeCheck; busy: boolean }
  | { kind: 'unknown'; data: NudgeUnknown; busy: boolean; asideOpen: boolean }
  | null;

type Options = {
  groupId: number;
  userId: string;
  hasNewcomers: boolean;
  draft: string;
  setDraft: (text: string) => void;
  /** Actually sends the message. */
  onSend: (text: string) => Promise<void> | void;
};

export function useNudge({ groupId, userId, hasNewcomers, draft, setDraft, onSend }: Options) {
  const [banner, setBanner] = useState<NudgeBannerState>(null);
  const [highlight, setHighlight] = useState<{ text: string; spans: Span[] } | null>(null);
  const [checkingUnknown, setCheckingUnknown] = useState(false);
  const checkAbort = useRef<AbortController | null>(null);
  // Terms the member already handled in this session (rewritten or kept): never re-nudge for them.
  const handledTerms = useRef(new Set<string>());
  // Drafts we produced ourselves (rewrite / aside) or already cleared with /nudge/unknown.
  const skipCheckFor = useRef<string | null>(null);
  const unknownClearedFor = useRef<string | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 1. Debounced glossary check while typing.
  useEffect(() => {
    const text = draft;
    if (!text.trim()) {
      checkAbort.current?.abort();
      return;
    }
    if (skipCheckFor.current === text) return;
    const timer = setTimeout(async () => {
      checkAbort.current?.abort();
      const ctrl = new AbortController();
      checkAbort.current = ctrl;
      try {
        const res = await api.nudgeCheck({ group_id: groupId, user_id: userId, draft: text }, ctrl.signal);
        if (ctrl.signal.aborted) return;
        const fresh = res.flagged_terms.filter((t) => !handledTerms.current.has(t.term.toLowerCase()));
        setBanner((b) => {
          if (b?.kind === 'unknown') return b; // the send-time banner wins
          if (res.show && fresh.length) {
            if (b?.kind !== 'check') Haptics.selectionAsync();
            return { kind: 'check', data: { ...res, flagged_terms: fresh }, busy: false };
          }
          return null;
        });
      } catch {
        // stale or failed check: leave the composer alone
      }
    }, CHECK_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, groupId, userId]);

  // Editing the draft dismisses a held "inside reference" state.
  const lastDraft = useRef(draft);
  useEffect(() => {
    if (lastDraft.current !== draft) {
      lastDraft.current = draft;
      setBanner((b) => (b?.kind === 'unknown' && !b.asideOpen && skipCheckFor.current !== draft ? null : b));
    }
  }, [draft]);

  const flash = useCallback((text: string, spans: Span[]) => {
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    setHighlight({ text, spans });
    highlightTimer.current = setTimeout(() => setHighlight(null), 2600);
  }, []);
  useEffect(
    () => () => {
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
    },
    [],
  );

  const swapDraft = useCallback(
    (text: string, changes: Span[]) => {
      skipCheckFor.current = text;
      setDraft(text);
      flash(text, changes);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    },
    [setDraft, flash],
  );

  // 2. Rewrite
  const rewrite = useCallback(async () => {
    if (banner?.kind !== 'check') return;
    const terms = banner.data.flagged_terms.map((t) => t.term);
    setBanner({ ...banner, busy: true });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      const res = await api.nudgeRewrite({ group_id: groupId, user_id: userId, draft, terms });
      terms.forEach((t) => handledTerms.current.add(t.toLowerCase()));
      setBanner(null);
      swapDraft(res.rewritten, res.changes);
    } catch {
      setBanner((b) => (b?.kind === 'check' ? { ...b, busy: false } : b));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  }, [banner, draft, groupId, userId, swapDraft]);

  // 3. Keep mine
  const keepMine = useCallback(() => {
    if (banner?.kind !== 'check') return;
    for (const t of banner.data.flagged_terms) {
      handledTerms.current.add(t.term.toLowerCase());
      api.nudgeDismiss({ group_id: groupId, user_id: userId, term: t.term }).catch(() => {});
    }
    Haptics.selectionAsync();
    setBanner(null);
  }, [banner, groupId, userId]);

  const doSend = useCallback(
    async (text: string) => {
      setBanner(null);
      checkAbort.current?.abort();
      skipCheckFor.current = null;
      unknownClearedFor.current = null;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      await onSend(text);
    },
    [onSend],
  );

  // 4. Send. Only the unknown-term check may hold it, and only once per draft.
  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || checkingUnknown) return;
    if (banner?.kind === 'unknown') {
      // "Send anyway"
      await doSend(text);
      return;
    }
    if (banner || !hasNewcomers || unknownClearedFor.current === draft) {
      await doSend(text);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), UNKNOWN_TIMEOUT_MS);
    setCheckingUnknown(true);
    try {
      const res = await api.nudgeUnknown({ group_id: groupId, user_id: userId, draft }, ctrl.signal);
      if (res.show && res.unknown_terms.length) {
        unknownClearedFor.current = draft;
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        setBanner({ kind: 'unknown', data: res, busy: false, asideOpen: false });
        return;
      }
    } catch {
      // timeout or error: send normally
    } finally {
      clearTimeout(timer);
      setCheckingUnknown(false);
    }
    await doSend(text);
  }, [draft, banner, hasNewcomers, checkingUnknown, groupId, userId, doSend]);

  // 5. Add aside
  const openAside = useCallback(() => {
    setBanner((b) => (b?.kind === 'unknown' ? { ...b, asideOpen: true } : b));
    Haptics.selectionAsync();
  }, []);

  const submitAside = useCallback(
    async (meaning: string) => {
      if (banner?.kind !== 'unknown' || !meaning.trim()) return;
      const term = banner.data.unknown_terms[0].term;
      setBanner({ ...banner, busy: true });
      try {
        const res = await api.nudgeAside({ group_id: groupId, user_id: userId, draft, term, meaning: meaning.trim() });
        handledTerms.current.add(term.toLowerCase());
        unknownClearedFor.current = res.rewritten;
        setBanner(null);
        swapDraft(res.rewritten, res.changes);
      } catch {
        setBanner((b) => (b?.kind === 'unknown' ? { ...b, busy: false } : b));
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    },
    [banner, draft, groupId, userId, swapDraft],
  );

  const dismiss = useCallback(() => setBanner(null), []);

  // An emptied composer never shows the typing-time banner.
  const visibleBanner = banner?.kind === 'check' && !draft.trim() ? null : banner;

  return {
    banner: visibleBanner,
    // Spans only apply to the exact text they were computed for; any edit drops them.
    highlights: highlight && highlight.text === draft ? highlight.spans : null,
    checkingUnknown,
    sendLabel: banner?.kind === 'unknown' ? 'Send anyway' : 'Send',
    send,
    rewrite,
    keepMine,
    openAside,
    submitAside,
    dismiss,
  };
}
