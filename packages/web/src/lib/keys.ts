/** Modifier names for the viewer's platform: ⌘ and ⌥ on Apple devices, Ctrl and Alt elsewhere. */
export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
export const MOD = IS_MAC ? "⌘" : "Ctrl";
export const ALT = IS_MAC ? "⌥" : "Alt";
/** A shortcut as one string: "⌘K" on a Mac, "Ctrl+K" elsewhere. */
export function shortcut(key: string, modifier: string = MOD): string {
  return IS_MAC ? `${modifier}${key}` : `${modifier}+${key}`;
}
