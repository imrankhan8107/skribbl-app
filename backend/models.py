from dataclasses import dataclass, field
from collections import deque
from enum import Enum
from typing import Optional
import asyncio


class RoomState(Enum):
    LOBBY = "lobby"
    WORD_SELECTION = "word_selection"
    PLAYING = "playing"
    GAME_OVER = "game_over"


class TurnEndReason(Enum):
    TIMER_EXPIRED = "timer_expired"
    ALL_GUESSED = "all_guessed"
    DRAWER_DISCONNECTED = "drawer_disconnected"


@dataclass
class Player:
    id: str                                      # UUID, server-assigned
    name: str                                    # Display name (1–20 chars)
    score: int = 0
    has_guessed: bool = False                    # True once correct guess in current turn
    is_connected: bool = True
    is_ready: bool = False                       # Ready status in lobby
    avatar: Optional[str] = None                 # Selected avatar ID
    websocket: object = None                     # WebSocket instance (not serialized)
    disconnect_time: Optional[float] = None      # epoch seconds
    cleanup_task: Optional[asyncio.Task] = None  # asyncio task that fires after 120s to permanently remove the player
    session_score: int = 0                       # Cumulative score across rematches in this room
    session_wins: int = 0                        # Total game wins in this room session
    session_games: int = 0                       # Total games played in this room session
    streak: int = 0                              # Current consecutive correct guess streak
    max_streak: int = 0                          # Peak guess streak in current game
    correct_guesses_count: int = 0               # Total correct guesses in current game
    fastest_guess_time: Optional[float] = None   # Lowest elapsed seconds for a correct guess
    drawer_points_earned: int = 0                # Total points earned while drawing
    is_spectator: bool = False                   # True if watching without playing
    host_reassign_task: Optional[asyncio.Task] = None  # asyncio task that fires after 3s if host drops and does not reconnect


@dataclass
class GameConfig:
    num_rounds: int = 3            # 2–10
    turn_duration: int = 80        # 30–180 seconds
    max_players: int = 8           # 2–12
    custom_words: list = field(default_factory=list)  # Custom word pack injected into word choices
    password: Optional[str] = None # Room password for private rooms (None for public)


@dataclass
class TurnState:
    drawer_id: str
    word: str
    hint: list                     # list of chars; '_' for hidden
    start_time: float              # epoch seconds
    word_choices: list             # 3 options shown to drawer
    timer_task: Optional[asyncio.Task] = None
    hint_task_40: Optional[asyncio.Task] = None
    hint_task_70: Optional[asyncio.Task] = None
    guess_order: list = field(default_factory=list)  # list of player_ids in order they guessed
    theme: Optional[dict] = None


@dataclass
class Room:
    code: str                      # 6-char alphanumeric
    host_id: str
    players: list = field(default_factory=list)       # ordered list for drawer rotation
    players_by_id: dict = field(default_factory=dict) # player_id -> Player for O(1) lookup
    config: GameConfig = field(default_factory=GameConfig)
    state: RoomState = RoomState.LOBBY
    current_round: int = 0
    drawer_index: int = 0          # index into players list
    turn: Optional[TurnState] = None
    used_words: set = field(default_factory=set)
    word_pool: deque = field(default_factory=deque)   # deque for O(1) popleft
    is_proxy: bool = False         # True if this room is owned by another worker

    def add_player(self, player: Player) -> None:
        """Add a player to the room with O(1) index update."""
        self.players.append(player)
        self.players_by_id[player.id] = player

    def remove_player(self, player_id: str) -> None:
        """Remove a player from the room."""
        self.players = [p for p in self.players if p.id != player_id]
        self.players_by_id.pop(player_id, None)

    def get_player(self, player_id: str) -> Optional[Player]:
        """O(1) player lookup by ID, with list fallback."""
        player = self.players_by_id.get(player_id)
        if player is not None:
            return player
        # Fallback for manually constructed rooms (tests)
        for p in self.players:
            if p.id == player_id:
                self.players_by_id[player_id] = p  # populate index
                return p
        return None

