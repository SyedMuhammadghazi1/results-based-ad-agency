/** Result shape shared by server actions and the <ActionForm> client component. */
export type ActionState = {
  ok: boolean;
  message?: string;
  errors?: string[];
  /** A value shown exactly once (e.g. a freshly generated API key). */
  secret?: string;
  secretLabel?: string;
};

export const initialActionState: ActionState = { ok: false };
