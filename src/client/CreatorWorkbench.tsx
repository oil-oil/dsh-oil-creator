import { useEffect, useRef, useState } from "react";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import { ContentInspector } from "./ContentInspector.tsx";
import { ContentSidebarPanel } from "./sidebar/ContentSidebarPanel.tsx";
import { CreatorSettingsCard } from "./CreatorSettingsCard.tsx";
import { useProfileEpoch, useSelectedContentId } from "./contentSelection.ts";
import type { CredentialsClient } from "./credentialsApi.ts";
import type { CreatorViewFace } from "./face.ts";
import type { CreatorKey } from "./locales.ts";
import { contentBindingForSession, relocateSessionContent, restoreSessionContent, startContentSession, type CreatorWorkbenchService } from "./workbench.ts";
import "./CreatorWorkbench.css";

export function CreatorWorkbench({ face, service, credentials, t }: {
  face: CreatorViewFace;
  credentials: CredentialsClient;
  service: CreatorWorkbenchService;
  t: (key: CreatorKey) => string;
}) {
  useProfileEpoch();
  const remoteReady = face.ready();
  const [selectedId, setSelectedId] = useSelectedContentId();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreFailed, setRestoreFailed] = useState(false);
  const previousSession = useRef<string | undefined>(undefined);
  const currentSelection = useRef(selectedId);
  currentSelection.current = selectedId;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    if (!remoteReady) return;
    previousSession.current = undefined;
    let queue = Promise.resolve();
    let revision = 0;
    const restore = () => {
      const session = service.currentSession();
      if (session === previousSession.current) return;
      previousSession.current = session;
      const ticket = ++revision;
      if (!service.isActive() || contentBindingForSession(service) === null) { setRestoring(false); setRestoreFailed(false); return; }
      setRestoring(true);
      setRestoreFailed(false);
      setError(null);
      queue = queue.then(async () => {
        if (!alive.current || ticket !== revision || !service.isActive()) return;
        try {
          const content = await restoreSessionContent(service, face);
          if (alive.current && ticket === revision && content !== null) setSelectedId(content);
        } catch (cause) {
          if (alive.current && ticket === revision) {
            setRestoreFailed(true);
            setError(`${cause instanceof Error ? cause.message : t("empty.error")} ${t("workbench.relocateHint")}`);
          }
        } finally {
          if (alive.current && ticket === revision) setRestoring(false);
        }
      });
    };
    restore();
    const stop = service.subscribe(restore);
    return () => { alive.current = false; revision += 1; stop(); };
  }, [service, face, remoteReady]);

  const reselect = async () => {
    const isCurrent = face.captureNavigation();
    setRestoring(true);
    try {
      const root = await face.pickDirectory();
      if (root === null || !alive.current || !isCurrent()) return;
      const id = await relocateSessionContent(service, root, face);
      if (!alive.current || !isCurrent() || id === null) return;
      setSelectedId(id);
      setRestoreFailed(false);
      setError(null);
    } catch (cause) {
      if (alive.current && isCurrent()) setError(cause instanceof Error ? cause.message : t("empty.error"));
    } finally {
      if (alive.current && isCurrent()) setRestoring(false);
    }
  };

  const begin = async () => {
    if (starting || restoring || restoreFailed || selectedId === null) return;
    const id = selectedId;
    const isCurrent = face.captureNavigation();
    setStarting(true);
    setError(null);
    try {
      const detail = await face.getContent(id);
      if (!alive.current || currentSelection.current !== id || !isCurrent()) return;
      await startContentSession(service, { id, folderPath: detail.folderPath }, face.pickDirectory);
    } catch (cause) {
      if (alive.current && isCurrent()) setError(cause instanceof Error ? cause.message : t("empty.error"));
    } finally {
      if (alive.current) setStarting(false);
    }
  };

  return (
    <section data-plugin="dsh-oil-creator" data-surface="workbench" data-selected={selectedId !== null || undefined}>
      <header className="workbenchHeader">
        <span>{t("workbench.title")}</span>
        <div className="workbenchActions">
          {selectedId !== null && <Button disabled={starting || restoring || restoreFailed} onClick={() => { void begin(); }}>{starting ? t("workbench.starting") : t("workbench.session")}</Button>}
          <Button onClick={() => { setSettingsOpen((value) => !value); }}>{settingsOpen ? t("workbench.library") : t("workbench.settings")}</Button>
        </div>
      </header>
      {error !== null && <div className="workbenchError" role="alert">{error}</div>}
      {restoreFailed && <Button disabled={restoring} onClick={() => { void reselect(); }}>{t("workbench.relocate")}</Button>}
      {restoring && <div className="workbenchEmpty" role="status">{t("workbench.restoring")}</div>}
      <div className="workbenchSettings" hidden={!settingsOpen}><CreatorSettingsCard {...face} credentials={credentials} t={t} /></div>
      <div className="workbenchBody" hidden={settingsOpen || restoring || restoreFailed}>
        <div className="workbenchLibrary"><ContentSidebarPanel {...face} t={t} suspended={restoring || restoreFailed} /></div>
        <div className="workbenchDetail">
          {selectedId === null ? <div className="workbenchEmpty">{t("workbench.select")}</div> : <ContentInspector {...face} t={t} suspended={restoring || restoreFailed} />}
        </div>
      </div>
    </section>
  );
}
