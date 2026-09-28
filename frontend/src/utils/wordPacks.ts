export interface WordPack {
  id: string;
  name: string;
  emoji: string;
  description: string;
  words: string[];
}

export const PRESET_WORD_PACKS: WordPack[] = [
  {
    id: "classic",
    name: "Classic Mix",
    emoji: "🎯",
    description: "Diverse everyday objects, nature, instruments, and places.",
    words: [
      "apple",
      "banana",
      "car",
      "dog",
      "elephant",
      "guitar",
      "house",
      "island",
      "kite",
      "mountain",
      "piano",
      "rainbow",
      "sun",
      "tree",
      "umbrella",
      "yacht",
      "castle",
      "diamond",
      "jungle",
      "moon",
      "octopus",
      "rocket",
      "volcano",
      "window",
    ],
  },
  {
    id: "animals",
    name: "Animals & Nature",
    emoji: "🐾",
    description: "Creatures from the deep ocean to the highest mountain peaks.",
    words: [
      "dolphin",
      "kangaroo",
      "koala",
      "penguin",
      "octopus",
      "butterfly",
      "starfish",
      "giraffe",
      "elephant",
      "cheetah",
      "chameleon",
      "jellyfish",
      "flamingo",
      "parrot",
      "hedgehog",
      "squirrel",
      "turtle",
      "whale",
      "dinosaur",
      "peacock",
      "badger",
    ],
  },
  {
    id: "food",
    name: "Food & Cuisine",
    emoji: "🍕",
    description: "Delicious dishes, snacks, fruits, and kitchen essentials.",
    words: [
      "pizza",
      "hamburger",
      "sushi",
      "taco",
      "croissant",
      "pancake",
      "donut",
      "icecream",
      "waffle",
      "spaghetti",
      "sandwich",
      "cupcake",
      "lollipop",
      "popcorn",
      "watermelon",
      "strawberry",
      "pineapple",
      "pretzel",
      "burrito",
      "avocado",
    ],
  },
  {
    id: "tech_gaming",
    name: "Tech & Sci-Fi",
    emoji: "🚀",
    description: "Futuristic gadgets, games, astronomy, and digital icons.",
    words: [
      "robot",
      "spaceship",
      "astronaut",
      "satellite",
      "joystick",
      "keyboard",
      "laser",
      "telescope",
      "microscope",
      "cyborg",
      "arcade",
      "drone",
      "headset",
      "battery",
      "superhero",
      "portal",
      "alien",
      "hologram",
      "rocket",
      "matrix",
    ],
  },
  {
    id: "fantasy",
    name: "Fantasy & Magic",
    emoji: "🧙",
    description: "Enchanted realms, mythical beasts, potions, and kingdoms.",
    words: [
      "wizard",
      "dragon",
      "unicorn",
      "phoenix",
      "castle",
      "potion",
      "cauldron",
      "treasure",
      "mermaid",
      "vampire",
      "ghost",
      "sword",
      "shield",
      "throne",
      "crystal",
      "wand",
      "spellbook",
      "dungeon",
      "goblin",
      "crown",
    ],
  },
];

const WORD_PACK_STORAGE_KEY = "skribbl_selected_pack";
const CUSTOM_WORDS_STORAGE_KEY = "skribbl_custom_words";

export function getStoredPackId(): string {
  if (typeof window === "undefined") return "classic";
  try {
    return localStorage.getItem(WORD_PACK_STORAGE_KEY) || "classic";
  } catch {
    return "classic";
  }
}

export function storePackId(id: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(WORD_PACK_STORAGE_KEY, id);
  } catch {
    // Ignore error
  }
}

export function getStoredCustomWords(): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(CUSTOM_WORDS_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function storeCustomWords(wordsText: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(CUSTOM_WORDS_STORAGE_KEY, wordsText);
  } catch {
    // Ignore error
  }
}

export function parseCustomWords(input: string): string[] {
  return input
    .split(/[,;\n]+/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length >= 2 && w.length <= 25 && /^[a-z0-9 ]+$/i.test(w));
}
