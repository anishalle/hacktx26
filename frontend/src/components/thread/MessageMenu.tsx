import { Button, ContextMenu, ControlGroup, Divider, Host, RNHostView } from '@expo/ui/swift-ui';
import type { ReactElement } from 'react';

export const QUICK_REACTIONS = ['❤️', '😂', '😮', '😢', '😡', '👍'] as const;

type Props = {
  children: ReactElement;
  onReact: (emoji: string) => void;
  onReply: () => void;
  onCopy: () => void;
  onExplain: () => void;
  /** "Save to Lore"; the item only shows when a handler is passed. */
  onSaveToLore?: () => void;
};

/**
 * Native SwiftUI context menu around a bubble (Expo UI, works in Expo Go): long-press lifts the
 * bubble with the system preview, a tapback row, then Explain / Reply / Copy / Save to Lore.
 */
export function MessageMenu({ children, onReact, onReply, onCopy, onExplain, onSaveToLore }: Props) {
  return (
    <Host matchContents>
      <ContextMenu>
        <ContextMenu.Items>
          {/* Menus lay out at most three controls per ControlGroup row, so two rows of three. */}
          <ControlGroup>
            {QUICK_REACTIONS.slice(0, 3).map((e) => (
              <Button key={e} label={e} onPress={() => onReact(e)} />
            ))}
          </ControlGroup>
          <ControlGroup>
            {QUICK_REACTIONS.slice(3).map((e) => (
              <Button key={e} label={e} onPress={() => onReact(e)} />
            ))}
          </ControlGroup>
          <Divider />
          <Button label="Explain" systemImage="sparkles" onPress={onExplain} />
          <Button label="Reply" systemImage="arrowshape.turn.up.left" onPress={onReply} />
          <Button label="Copy" systemImage="doc.on.doc" onPress={onCopy} />
          {onSaveToLore ? <Button label="Save to Lore" systemImage="sparkles.rectangle.stack" onPress={onSaveToLore} /> : null}
        </ContextMenu.Items>
        <ContextMenu.Trigger>
          <RNHostView matchContents>{children}</RNHostView>
        </ContextMenu.Trigger>
      </ContextMenu>
    </Host>
  );
}
