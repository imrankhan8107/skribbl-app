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
    websocket: object = None                     # WebSocket instance (not serialized)
    disconnect_time: Optional[float] = None      # epoch seconds
    cleanup_task: Optional[asyncio.Task] = None  # asyncio task that fires after 120s to permanently remove the player


@dataclass
class GameConfig:
    num_rounds: int = 3            # 2–10
    turn_duration: int = 80        # 30–180 seconds
    max_players: int = 8           # 2–12


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

