"""Themed word packs and default word list for the Pictionary game.

Contains categorized word packs with large quantities of nouns suitable for drawing and guessing.
Each round, drawers can choose from 3 random themes, each with pre-fetched words.
"""

from typing import Any

WORD_PACKS: list[dict[str, Any]] = [
    {
        "id": "animals",
        "name": "Animals & Wildlife",
        "emoji": "🐾",
        "words": [
            "dog", "elephant", "whale", "zebra", "eagle", "kangaroo", "octopus",
            "penguin", "giraffe", "jellyfish", "owl", "dinosaur", "wolf", "butterfly",
            "lion", "parrot", "rabbit", "snake", "tiger", "dolphin", "frog",
            "horse", "koala", "spider", "turtle", "gorilla", "insect", "lobster",
            "ostrich", "peacock", "caterpillar", "flamingo", "grasshopper", "goldfish",
            "iguana", "dragonfly", "starfish", "bear", "camel", "cat", "cheetah",
            "chameleon", "chimpanzee", "crab", "crocodile", "deer", "duck", "fox",
            "hedgehog", "hippo", "mouse", "panda", "rhino", "seagull", "seal",
            "shark", "sheep", "sloth", "snail", "squirrel", "swan", "walrus",
            "badger", "hamster", "raccoon", "otter", "beaver", "skunk",
        ],
    },
    {
        "id": "food",
        "name": "Food & Cuisine",
        "emoji": "🍕",
        "words": [
            "apple", "banana", "lemon", "mushroom", "orange", "grapes", "onion",
            "bread", "cherry", "olive", "pumpkin", "tomato", "waffle", "pretzel",
            "donut", "jellybean", "lollipop", "sandwich", "hamburger", "icecream",
            "avocado", "bacon", "bagel", "cake", "cheese", "chocolate", "cookie",
            "corn", "croissant", "cupcake", "egg", "hotdog", "noodles", "pancake",
            "peach", "peanut", "pear", "pie", "pineapple", "pizza", "popcorn",
            "potato", "salad", "sausage", "soup", "spaghetti", "steak", "strawberry",
            "sushi", "taco", "toast", "watermelon", "muffin", "honey", "butter",
            "carrot", "mango", "coconut", "cookie", "dumpling", "broccoli",
        ],
    },
    {
        "id": "objects",
        "name": "Everyday Objects",
        "emoji": "📦",
        "words": [
            "jacket", "kite", "lamp", "notebook", "piano", "umbrella", "violin",
            "xylophone", "diamond", "globe", "hammer", "quilt", "window", "anchor",
            "balloon", "candle", "envelope", "feather", "key", "ladder", "magnet",
            "necklace", "scissors", "telescope", "vase", "camera", "helmet", "compass",
            "jewel", "knot", "ring", "skull", "arrow", "clock", "drum", "flag",
            "heart", "ink", "jar", "mirror", "wheel", "needle", "suitcase", "zipper",
            "harp", "jigsaw", "kettle", "napkin", "trophy", "battery", "dominoes",
            "jukebox", "lantern", "microscope", "newspaper", "origami", "ukulele",
            "blanket", "crayon", "keyboard", "mailbox", "nutcracker", "paintbrush",
            "toothbrush", "wrench", "backpack", "chandelier", "earring", "glasses",
            "iron", "horseshoe", "uniform", "lanyard", "book", "bottle", "bucket",
            "chair", "couch", "cup", "dice", "fork", "headphones", "knife", "lock",
            "mug", "pencil", "pillow", "plate", "radio", "rope", "soap", "spoon",
            "table", "towel", "watch",
        ],
    },
    {
        "id": "nature",
        "name": "Nature & Weather",
        "emoji": "🌲",
        "words": [
            "flower", "mountain", "ocean", "rainbow", "sun", "tree", "forest",
            "moon", "nest", "snowflake", "tornado", "volcano", "waterfall", "iceberg",
            "leaf", "rose", "cactus", "acorn", "icicle", "quicksand", "earth",
            "garden", "blizzard", "cave", "cliff", "cloud", "comet", "desert",
            "eclipse", "fire", "galaxy", "island", "jungle", "lightning", "meteor",
            "puddle", "rain", "river", "rock", "smoke", "star", "storm",
            "sunrise", "sunset", "thunder", "valley", "wave", "wind",
        ],
    },
    {
        "id": "places",
        "name": "Places & Buildings",
        "emoji": "🏰",
        "words": [
            "house", "bridge", "castle", "igloo", "lighthouse", "village", "throne",
            "beach", "fountain", "maze", "windmill", "elevator", "escalator", "fireplace",
            "airport", "aquarium", "bakery", "bank", "barn", "cabin", "church",
            "circus", "cottage", "factory", "farm", "fort", "gym", "hospital",
            "hotel", "library", "mall", "market", "museum", "palace", "park",
            "playground", "prison", "pyramid", "school", "skyscraper", "stadium",
            "station", "supermarket", "temple", "theater", "tower", "zoo",
        ],
    },
    {
        "id": "vehicles",
        "name": "Vehicles & Travel",
        "emoji": "🚀",
        "words": [
            "car", "yacht", "airplane", "rocket", "helicopter", "parachute", "surfboard",
            "engine", "kayak", "hammock", "trampoline", "football", "volleyball",
            "ambulance", "bicycle", "blimp", "boat", "bulldozer", "bus", "canoe",
            "carriage", "ferry", "firetruck", "forklift", "hoverboard", "jetski",
            "limousine", "motorcycle", "raft", "scooter", "skateboard", "sled",
            "snowboard", "spaceship", "submarine", "tank", "taxi", "tractor",
            "train", "truck", "van",
        ],
    },
    {
        "id": "fantasy",
        "name": "Fantasy & Sci-Fi",
        "emoji": "🧙",
        "words": [
            "queen", "unicorn", "dragon", "robot", "wizard", "firework", "ghost",
            "treasure", "vampire", "king", "angel", "mermaid", "witch", "emerald",
            "radar", "satellite", "alien", "cauldron", "crystal", "cyborg", "demon",
            "dungeon", "elf", "fairy", "flying carpet", "genie", "giant", "goblin",
            "laser", "magic wand", "monster", "mummy", "pegasus", "phoenix", "portal",
            "potion", "shield", "spellbook", "sword", "time machine", "zombie",
        ],
    },
    {
        "id": "characters",
        "name": "Characters & Roles",
        "emoji": "👨‍🍳",
        "words": [
            "ninja", "pirate", "nurse", "judge", "astronaut", "dentist", "scarecrow",
            "actor", "artist", "athlete", "baby", "baker", "barber", "builder",
            "captain", "carpenter", "chef", "clown", "detective", "diver", "doctor",
            "farmer", "firefighter", "guard", "hunter", "knight", "lifeguard", "magician",
            "mailman", "mechanic", "musician", "painter", "pilot", "police", "prince",
            "princess", "sailor", "scientist", "singer", "soldier", "spy", "superhero",
        ],
    },
]

# Quick lookup by pack ID
WORD_PACKS_BY_ID: dict[str, dict[str, Any]] = {p["id"]: p for p in WORD_PACKS}

# Reverse lookup: word (lowercase) -> {id, name, emoji}
WORD_TO_PACK: dict[str, dict[str, str]] = {}
for _pack in WORD_PACKS:
    for _w in _pack["words"]:
        WORD_TO_PACK[_w.lower()] = {
            "id": _pack["id"],
            "name": _pack["name"],
            "emoji": _pack["emoji"],
        }

# Unified complete words list for backwards compatibility
WORDS: list[str] = sorted(list({_w.lower() for _pack in WORD_PACKS for _w in _pack["words"]}))
