import { useEffect, useState } from "react";
import { IconChevronDownOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";

import { normalizeEnabledPlatforms, PUBLISH_PLATFORMS } from "../platforms.ts";
import { COVER_KEY_REFS, SUBTITLE_KEY_REFS } from "../secrets.ts";
import type { CreatorCapabilities, CreatorProfile, CreatorSecrets, PublishPlatform } from "../types.ts";
import type { CredentialsClient, SecretDraft } from "./credentialsApi.ts";
import { applyDescribed, secretDraftOf } from "./credentialsApi.ts";
import type { CreatorViewFace } from "./face.ts";
import { useProfileEpoch } from "./contentSelection.ts";
import type { CreatorKey } from "./locales.ts";
import { CREATOR_SETTINGS_PLATFORMS } from "./publishPlatforms.ts";
import { ActionBar, ActionButton } from "./ui/ActionButton.tsx";
import { StatusPill, type StatusTone } from "./ui/StatusPill.tsx";
import "./CreatorSettingsCard.css";

export type CreatorSettingsCardProps =
  Pick<CreatorViewFace, "ready" | "getSettings" | "getCapabilities" | "setLibraryRoot" | "setProfile" | "setScriptRules" | "pickDirectory">
  & { credentials: CredentialsClient | undefined; t: (key: CreatorKey) => string };

const EMPTY_SECRETS: CreatorSecrets = {
  subtitle: { kind: "subtitle", ref: SUBTITLE_KEY_REFS[0], configured: false, writable: true },
  cover: { kind: "cover", ref: COVER_KEY_REFS[0], configured: false, writable: true },
};

const EMPTY_PROFILE: CreatorProfile = { enabledPlatforms: [...PUBLISH_PLATFORMS] };

const CAPABILITY_ROWS: ReadonlyArray<{ id: keyof CreatorCapabilities; label: CreatorKey }> = [
  { id: "library", label: "settings.capability.library" },
  { id: "screenStudio", label: "settings.capability.screenStudio" },
  { id: "subtitleSkill", label: "settings.capability.subtitle" },
  { id: "coverSkill", label: "settings.capability.cover" },
  { id: "editingSkill", label: "settings.capability.editing" },
  { id: "publishSkill", label: "settings.capability.publish" },
  { id: "articleSkill", label: "settings.capability.article" },
  { id: "publishSync", label: "settings.capability.ego" },
];

function capabilityTone(state: CreatorCapabilities[keyof CreatorCapabilities]["state"]): StatusTone {
  return state === "ready" ? "success" : "neutral";
}

function capabilityStateKey(state: CreatorCapabilities[keyof CreatorCapabilities]["state"]): CreatorKey {
  if (state === "ready") return "settings.state.ready";
  if (state === "unsupported") return "settings.state.unsupported";
  return "settings.state.missing";
}

function cloneProfile(profile: CreatorProfile): CreatorProfile {
  return { enabledPlatforms: [...profile.enabledPlatforms] };
}

function sameProfile(left: CreatorProfile, right: CreatorProfile): boolean {
  return left.enabledPlatforms.length === right.enabledPlatforms.length
    && left.enabledPlatforms.every((platform, index) => platform === right.enabledPlatforms[index]);
}

export function CreatorSettingsCard({
  t,
  ready,
  getSettings,
  setLibraryRoot,
  setProfile,
  setScriptRules,
  pickDirectory,
  getCapabilities,
  credentials,
}: CreatorSettingsCardProps) {
  const profileEpoch = useProfileEpoch();
  const [open, setOpen] = useState(false);
  const [savedRoot, setSavedRoot] = useState("");
  const [draftRoot, setDraftRoot] = useState("");
  const [savedProfile, setSavedProfile] = useState<CreatorProfile>(EMPTY_PROFILE);
  const [draftProfile, setDraftProfile] = useState<CreatorProfile>(EMPTY_PROFILE);
  const [savedRules, setSavedRules] = useState("");
  const [draftRules, setDraftRules] = useState("");
  const [secrets, setSecrets] = useState<SecretDraft[]>([
    secretDraftOf(EMPTY_SECRETS.subtitle),
    secretDraftOf(EMPTY_SECRETS.cover),
  ]);
  const [loaded, setLoaded] = useState(false);
  const [capabilities, setCapabilities] = useState<CreatorCapabilities | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [saved, setSaved] = useState(false);
  const [keyFailed, setKeyFailed] = useState(false);

  useEffect(() => {
    if (!ready()) return;
    if (loaded && (draftRoot !== savedRoot || !sameProfile(draftProfile, savedProfile) || draftRules !== savedRules)) return;
    let cancelled = false;
    void getSettings().then((settings) => {
      if (cancelled) return;
      setSavedRoot(settings.libraryRoot);
      setDraftRoot(settings.libraryRoot);
      setSavedProfile(cloneProfile(settings.profile));
      setDraftProfile(cloneProfile(settings.profile));
      setSavedRules(settings.scriptRules ?? "");
      setDraftRules(settings.scriptRules ?? "");
      const nextSecrets = settings.secrets ?? EMPTY_SECRETS;
      setSecrets([
        secretDraftOf(nextSecrets.subtitle),
        secretDraftOf(nextSecrets.cover),
      ]);
      setLoaded(true);
    }, () => {
      if (!cancelled) setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [ready, getSettings, open, profileEpoch]);

  useEffect(() => {
    if (!open || credentials === undefined) return;
    let cancelled = false;
    const refs = secrets.map((item) => item.ref);
    void credentials.describe({ refs }).then((response) => {
      if (cancelled || !response.result.ok || response.result.value === undefined) {
        if (!cancelled && (response.result.ok !== true)) {
          setSecrets((current) => current.map((item) => ({ ...item, loadError: true })));
        }
        return;
      }
      const described = response.result.value.credentials;
      setSecrets((current) => current.map((item) => applyDescribed(item, described)));
    }, () => {
      if (!cancelled) setSecrets((current) => current.map((item) => ({ ...item, loadError: true })));
    });
    return () => {
      cancelled = true;
    };
  }, [open, credentials, secrets.map((item) => item.ref).join(",")]);

  useEffect(() => {
    if (!open || !ready()) return;
    let cancelled = false;
    void getCapabilities().then((next) => {
      if (!cancelled) setCapabilities(next);
    }, () => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, ready, getCapabilities]);

  const dirtyRoot = draftRoot !== savedRoot;
  const dirtyProfile = !sameProfile(draftProfile, savedProfile);
  const dirtyRules = draftRules !== savedRules;
  const dirtyKeys = secrets.some((item) => item.nextValue.trim() !== "");
  const dirty = dirtyRoot || dirtyProfile || dirtyRules || dirtyKeys;
  const title = t("settings.title" as CreatorKey);

  const onPick = async () => {
    const path = await pickDirectory();
    if (path === null) return;
    setDraftRoot(path);
    setSaved(false);
    setFailed(false);
  };

  const patchProfile = (platform: PublishPlatform, enabled: boolean) => {
    setDraftProfile((current) => {
      const enabledPlatforms = enabled
        ? [...current.enabledPlatforms, platform]
        : current.enabledPlatforms.filter((item) => item !== platform);
      return { enabledPlatforms: normalizeEnabledPlatforms(enabledPlatforms) };
    });
    setSaved(false);
    setFailed(false);
  };

  const onSave = async () => {
    if (!dirty || saving) return;
    if (dirtyRoot && draftRoot === "") return;
    setSaving(true);
    setFailed(false);
    setKeyFailed(false);
    setSaved(false);
    try {
      if (dirtyKeys) {
        if (credentials === undefined) {
          setKeyFailed(true);
          return;
        }
        for (const item of secrets) {
          const value = item.nextValue.trim();
          if (value === "") continue;
          if (!(await credentials.set({ ref: item.ref, value })).result.ok) {
            setKeyFailed(true);
            return;
          }
        }
        setSecrets((current) => current.map((item) => (
          item.nextValue.trim() === ""
            ? item
            : { ...item, nextValue: "", configured: true, loadError: false }
        )));
      }
      if (dirtyRoot) {
        await setLibraryRoot(draftRoot);
        setSavedRoot(draftRoot);
      }
      if (dirtyProfile) {
        await setProfile(draftProfile);
        setSavedProfile(cloneProfile(draftProfile));
      }
      if (dirtyRules) {
        await setScriptRules(draftRules);
        setSavedRules(draftRules);
      }
      setSaved(true);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section data-plugin="dsh-oil-creator" data-surface="settings-card" className={open ? "card open" : "card"}>
      <button
        type="button"
        className="header"
        aria-expanded={open}
        aria-label={`${t((open ? "settings.collapse" : "settings.expand") as CreatorKey)}: ${title}`}
        onClick={() => { setOpen(!open); }}
      >
        <span className="headText">
          <span className="name">{title}</span>
          <span className="description">{t("settings.description" as CreatorKey)}</span>
        </span>
        {dirty && <span className="pending">{t("settings.save" as CreatorKey)}</span>}
        <IconChevronDownOutlineRegular className={open ? "chevron open" : "chevron"} />
      </button>
      {open && (
        <div className="body">
          {capabilities !== undefined && (
            <div className="field">
              <span className="fieldLabel">{t("settings.capabilities" as CreatorKey)}</span>
              <span className="fieldHint">{t("settings.capabilitiesHint" as CreatorKey)}</span>
              <div className="capabilityGrid">
                {CAPABILITY_ROWS.map((row) => {
                  const item = capabilities[row.id];
                  return (
                    <span key={row.id} className="capabilityItem" title={item.detail}>
                      <span className="capabilityName">{t(row.label)}</span>
                      <StatusPill tone={capabilityTone(item.state)}>
                        {t(capabilityStateKey(item.state))}
                      </StatusPill>
                    </span>
                  );
                })}
              </div>
            </div>
          )}
          <label className="field">
            <span className="fieldLabel">{t("settings.libraryRoot" as CreatorKey)}</span>
            <span className="fieldHint">{t("settings.libraryRootHint" as CreatorKey)}</span>
            <span className="pathRow">
              <span className={draftRoot === "" ? "path empty" : "path"}>
                {draftRoot === "" ? t("settings.libraryRootEmpty" as CreatorKey) : draftRoot}
              </span>
              <ActionButton onClick={() => { void onPick(); }}>
                {t("settings.pick" as CreatorKey)}
              </ActionButton>
            </span>
          </label>
          <div className="field">
            <span className="fieldLabel">{t("settings.enabledPlatforms" as CreatorKey)}</span>
            <span className="fieldHint">{t("settings.enabledPlatformsHint" as CreatorKey)}</span>
            {CREATOR_SETTINGS_PLATFORMS.map((platform) => (
              <label className="inputLabel" key={platform.key}>
                <span>
                  <input
                    type="checkbox"
                    checked={draftProfile.enabledPlatforms.includes(platform.key)}
                    onChange={(event) => { patchProfile(platform.key, event.target.checked); }}
                  />
                  {t(platform.label)}
                </span>
              </label>
            ))}
          </div>
          <div className="field">
            <span className="fieldLabel">{t("settings.scriptRules" as CreatorKey)}</span>
            <span className="fieldHint">{t("settings.scriptRulesHint" as CreatorKey)}</span>
            <textarea
              className="input textarea"
              rows={6}
              placeholder={t("settings.scriptRulesPlaceholder" as CreatorKey)}
              value={draftRules}
              onChange={(event) => {
                setDraftRules(event.target.value);
                setSaved(false);
                setFailed(false);
              }}
            />
          </div>
          <div className="field">
            <span className="fieldLabel">{t("settings.secrets" as CreatorKey)}</span>
            <span className="fieldHint">{t("settings.secretsHint" as CreatorKey)}</span>
            {secrets.map((item) => (
              <label className="inputLabel" key={item.kind}>
                <span className="secretHead">
                  <span>{t(`settings.secret.${item.kind}` as CreatorKey)}</span>
                  <StatusPill tone={item.loadError ? "error" : item.configured ? "success" : "neutral"}>
                    {t((
                      item.loadError
                        ? "settings.secret.loadFailed"
                        : item.configured
                          ? "settings.secret.configured"
                          : "settings.secret.missing"
                    ) as CreatorKey)}
                  </StatusPill>
                </span>
                <span className="fieldHint">{t(`settings.secret.${item.kind}Hint` as CreatorKey)}</span>
                <input
                  className="input"
                  type="password"
                  autoComplete="off"
                  placeholder={t("settings.secret.placeholder" as CreatorKey)}
                  disabled={!item.writable || saving}
                  value={item.nextValue}
                  onChange={(event) => {
                    const value = event.target.value;
                    setSecrets((current) => current.map((row) => (
                      row.kind === item.kind ? { ...row, nextValue: value } : row
                    )));
                    setSaved(false);
                    setFailed(false);
                    setKeyFailed(false);
                  }}
                />
                {!item.writable && (
                  <span className="fieldHint">{t("settings.secret.readOnly" as CreatorKey)}</span>
                )}
              </label>
            ))}
          </div>
          <div className="footer">
            {failed && <p className="failed" role="status">{t("settings.saveFailed" as CreatorKey)}</p>}
            {keyFailed && <p className="failed" role="status">{t("settings.secret.saveFailed" as CreatorKey)}</p>}
            {saved && !dirty && <p className="ok" role="status">{t("settings.saved" as CreatorKey)}</p>}
            <ActionBar>
              <ActionButton
                disabled={!dirty || saving || !loaded}
                onClick={() => {
                  setDraftRoot(savedRoot);
                  setDraftProfile(cloneProfile(savedProfile));
                  setDraftRules(savedRules);
                  setSecrets((current) => current.map((item) => ({ ...item, nextValue: "" })));
                  setFailed(false);
                  setKeyFailed(false);
                  setSaved(false);
                }}
              >
                {t("settings.discard" as CreatorKey)}
              </ActionButton>
              <ActionButton
                tone="primary"
                disabled={!dirty || saving || (dirtyRoot && draftRoot === "")}
                onClick={() => { void onSave(); }}
              >
                {t((saving ? "settings.saving" : "settings.save") as CreatorKey)}
              </ActionButton>
            </ActionBar>
          </div>
        </div>
      )}
    </section>
  );
}
