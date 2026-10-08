import type { SecretView } from "../types.ts";

export interface CredentialView {
  configured: boolean;
  writable: boolean;
  source?: string;
}

export interface CredentialsClient {
  describe: (request: { refs: string[] }) => Promise<{
    result: {
      ok: boolean;
      value?: { credentials: Record<string, CredentialView> };
    };
  }>;
  set: (request: { ref: string; value: string }) => Promise<{
    result: { ok: boolean };
  }>;
}

export interface SecretDraft {
  kind: SecretView["kind"];
  ref: string;
  configured: boolean;
  writable: boolean;
  source?: string;
  nextValue: string;
  loadError: boolean;
}

export function secretDraftOf(view: SecretView): SecretDraft {
  return {
    kind: view.kind,
    ref: view.ref,
    configured: view.configured,
    writable: view.writable,
    ...(view.source === undefined ? {} : { source: view.source }),
    nextValue: "",
    loadError: false,
  };
}

export function applyDescribed(
  draft: SecretDraft,
  credentials: Record<string, CredentialView | undefined>,
): SecretDraft {
  const row = credentials[draft.ref];
  if (row === undefined) {
    return { ...draft, configured: false, writable: true, loadError: false };
  }
  return {
    ...draft,
    configured: row.configured === true,
    writable: row.writable !== false,
    ...(row.source === undefined ? {} : { source: row.source }),
    loadError: false,
  };
}

/** The current Credentials remote accepts positional arguments, not legacy API envelopes. */
export function credentialsOf(ctx: { get: (name: string) => unknown }): CredentialsClient {
  const remote = () => {
    const value = ctx.get("remote.credentials") as {
      describe: (refs: string[]) => Promise<{ ok: boolean; value?: Record<string, CredentialView> }>;
      set: (ref: string, value: string) => Promise<{ ok: boolean }>;
    } | undefined;
    if (value === undefined) throw new Error("凭据服务尚未就绪，请稍后重试。");
    return value;
  };
  return {
    async describe({ refs }) {
      const answer = await remote().describe(refs);
      return { result: answer.ok && answer.value !== undefined
        ? { ok: true, value: { credentials: answer.value } }
        : { ok: false } };
    },
    async set({ ref, value }) { return { result: await remote().set(ref, value) }; },
  };
}
