// Tiny cross-screen signals (sheet → thread) that don't belong in route params.

type Fn<T> = (payload: T) => void;

function channel<T>() {
  const subs = new Set<Fn<T>>();
  return {
    emit: (payload: T) => subs.forEach((fn) => fn(payload)),
    on: (fn: Fn<T>) => {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}

/** Catch-up bullet tapped: open the thread at `around=messageId` and highlight it. */
export const threadJump = channel<{ groupId: number; messageId: number }>();

/** Catch-up sheet "Mark as read" tapped. */
export const catchupMarkRead = channel<{ groupId: number }>();
