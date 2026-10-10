import type { SettingsForms } from "@deepseek-ai/dsh-settings";

/** Settings forms now derive discovery from the plugin's Config/entry id. */
export function registerCreatorSettingsNamespace(settings: Pick<SettingsForms, "configure">): () => void {
  return settings.configure({ auto: false });
}
