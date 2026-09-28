export interface AvatarInfo {
  id: string;
  emoji: string;
  label: string;
  bgColor: string;
}

export const AVATARS: AvatarInfo[] = [
  { id: "fox", emoji: "🦊", label: "Fox", bgColor: "#ffedd5" },
  { id: "panda", emoji: "🐼", label: "Panda", bgColor: "#f3f4f6" },
  { id: "lion", emoji: "🦁", label: "Lion", bgColor: "#fef3c7" },
  { id: "frog", emoji: "🐸", label: "Frog", bgColor: "#dcfce7" },
  { id: "octopus", emoji: "🐙", label: "Octopus", bgColor: "#fce7f3" },
  { id: "unicorn", emoji: "🦄", label: "Unicorn", bgColor: "#fae8ff" },
  { id: "robot", emoji: "🤖", label: "Robot", bgColor: "#e0e7ff" },
  { id: "alien", emoji: "👽", label: "Alien", bgColor: "#d1fae5" },
  { id: "wizard", emoji: "🧙", label: "Wizard", bgColor: "#ede9fe" },
  { id: "artist", emoji: "🎨", label: "Artist", bgColor: "#ffe4e6" },
  { id: "astronaut", emoji: "🚀", label: "Astronaut", bgColor: "#e0f2fe" },
  { id: "cat", emoji: "🐱", label: "Cat", bgColor: "#ffedd5" },
  { id: "dog", emoji: "🐶", label: "Dog", bgColor: "#fef9c3" },
  { id: "tiger", emoji: "🐯", label: "Tiger", bgColor: "#ffedd5" },
  { id: "owl", emoji: "🦉", label: "Owl", bgColor: "#f1f5f9" },
  { id: "pizza", emoji: "🍕", label: "Pizza", bgColor: "#fee2e2" },
];

const AVATAR_STORAGE_KEY = "skribbl_player_avatar";

export function getStoredAvatarId(): string {
  if (typeof window === "undefined") return AVATARS[0].id;
  try {
    const saved = localStorage.getItem(AVATAR_STORAGE_KEY);
    if (saved && AVATARS.some((a) => a.id === saved)) {
      return saved;
    }
  } catch {
    // Ignore error
  }
  return AVATARS[0].id;
}

export function storeAvatarId(id: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(AVATAR_STORAGE_KEY, id);
  } catch {
    // Ignore error
  }
}

export function getAvatarById(id?: string): AvatarInfo {
  if (id) {
    const found = AVATARS.find((a) => a.id === id);
    if (found) return found;
  }
  return AVATARS[0];
}

/**
 * Deterministically picks an avatar if none is explicitly provided,
 * using a hash of the player's name or ID so they always look consistent.
 */
export function getAvatarForPlayer(nameOrId: string, explicitAvatarId?: string): AvatarInfo {
  if (explicitAvatarId) {
    const found = AVATARS.find((a) => a.id === explicitAvatarId);
    if (found) return found;
  }
  if (!nameOrId) return AVATARS[0];

  let hash = 0;
  for (let i = 0; i < nameOrId.length; i++) {
    hash = (hash << 5) - hash + nameOrId.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % AVATARS.length;
  return AVATARS[index];
}
