# Requirements Document

## Introduction

A real-time multiplayer drawing and guessing game inspired by skribbl.io. Players join or create rooms (lobbies), take turns drawing a secretly assigned word while other players race to guess it via a chat interface. The game tracks scores across rounds, announces winners, and supports a configurable number of players and rounds. The system consists of a browser-based frontend (drawing canvas, chat/guessing UI, lobby management) and a backend server (real-time WebSocket communication, game state management, room lifecycle).

## Glossary

- **Game_Server**: The backend server responsible for managing rooms, game state, and real-time communication.
- **Client**: The browser-based frontend application used by a player.
- **Room**: An isolated game session identified by a unique code, containing a set of players and game configuration.
- **Lobby**: The pre-game waiting area within a Room before a game round begins.
- **Player**: A user connected to a Room with a chosen display name.
- **Host**: The Player who created the Room and has administrative control over it.
- **Drawer**: The Player whose turn it is to draw the current word.
- **Guesser**: Any Player in the Room who is not the current Drawer.
- **Word**: A secret string assigned to the Drawer at the start of each turn.
- **Canvas**: The shared drawing surface rendered in the Client's browser.
- **Stroke**: A single continuous drawn line on the Canvas, defined by a sequence of coordinates, a color, and a brush size.
- **Chat**: The real-time message feed used by Guessers to submit guesses and receive game messages.
- **Round**: One full cycle in which every Player has had one turn as the Drawer.
- **Turn**: The period during which a single Player draws and others guess.
- **Score**: An integer value representing a Player's accumulated points in the current game.
- **Hint**: A partially revealed version of the Word shown to Guessers (e.g., underscores with some letters revealed over time).
- **Room_Code**: A short, human-readable alphanumeric string uniquely identifying a Room.

---

## Requirements

### Requirement 1: Room Creation and Joining

**User Story:** As a player, I want to create or join a game room, so that I can play with others.

#### Acceptance Criteria

1. THE Game_Server SHALL generate a unique Room_Code for each newly created Room.
2. WHEN a Player submits a valid display name and requests to create a Room, THE Game_Server SHALL create a new Room, assign the Player as Host, and return the Room_Code.
3. WHEN a Player submits a valid display name and a Room_Code, THE Game_Server SHALL add the Player to the matching Room if the Room exists, is in the Lobby state, and has not reached its maximum player capacity.
4. IF a Player attempts to join a Room using a Room_Code that does not match any existing Room, THEN THE Game_Server SHALL return an error indicating the Room was not found.
5. IF a Player attempts to join a Room that is already in progress (not in Lobby state), THEN THE Game_Server SHALL return an error indicating the Room is not accepting new players.
6. IF a Player attempts to join a Room that has reached its maximum player capacity, THEN THE Game_Server SHALL return an error indicating the Room is full.
7. THE Game_Server SHALL enforce a maximum of 12 Players per Room.
8. THE Game_Server SHALL enforce a minimum display name length of 1 character and a maximum of 20 characters.
9. IF a Player submits a display name that violates the length constraints, THEN THE Game_Server SHALL return a descriptive validation error.
10. WHEN a Player joins a Room, THE Game_Server SHALL broadcast the updated Player list to all Players in that Room.

---

### Requirement 2: Lobby and Game Configuration

**User Story:** As a host, I want to configure the game settings before starting, so that I can tailor the experience for my group.

#### Acceptance Criteria

1. WHILE a Room is in Lobby state, THE Host SHALL be able to configure the number of Rounds (between 2 and 10 inclusive).
2. WHILE a Room is in Lobby state, THE Host SHALL be able to configure the Turn duration in seconds (between 30 and 180 inclusive).
3. WHILE a Room is in Lobby state, THE Host SHALL be able to configure the maximum number of Players (between 2 and 12 inclusive).
4. WHEN the Host updates a game setting, THE Game_Server SHALL broadcast the updated configuration to all Players in the Room.
5. IF a non-Host Player attempts to change game settings, THEN THE Game_Server SHALL reject the request and return a permission error.
6. WHILE a Room is in Lobby state and has at least 2 Players, THE Host SHALL be able to start the game.
7. IF the Host attempts to start the game with fewer than 2 Players, THEN THE Game_Server SHALL reject the request and return an error indicating insufficient players.
8. WHEN a Player disconnects from a Room in Lobby state, THE Game_Server SHALL remove the Player from the Room and broadcast the updated Player list.
9. WHEN the Host disconnects from a Room in Lobby state, THE Game_Server SHALL assign the Host role to the next Player in the Room, or close the Room if no Players remain.
10. WHILE a Room is in Lobby state, THE Client SHALL allow Players to toggle their ready status via a `toggle_ready` message, and THE Game_Server SHALL broadcast the updated Player list with ready states.
11. WHILE a Room is in Lobby state, THE Client SHALL allow Players to send chat messages that are broadcast to all Players in the Room.
12. WHILE a Room is in Lobby state, THE Host SHALL be able to kick a Player from the Room, and THE Game_Server SHALL remove the kicked Player, send a `kicked` message to the kicked Player's Client, and broadcast the updated Player list.
13. WHILE a Room is in Lobby state or during a game, THE Client SHALL allow a Player to voluntarily leave the Room via a `leave_room` message, and THE Game_Server SHALL remove the Player and broadcast the updated Player list.

---

### Requirement 3: Turn and Round Management

**User Story:** As a player, I want the game to automatically manage turns and rounds, so that every player gets a fair chance to draw.

#### Acceptance Criteria

1. WHEN a game starts, THE Game_Server SHALL assign the first Drawer by selecting the first Player in the Room's Player list.
2. WHEN a Turn begins, THE Game_Server SHALL select a Word from the word list and send it exclusively to the Drawer.
3. WHEN a Turn begins, THE Game_Server SHALL send a Hint to all Guessers consisting of underscores representing each character of the Word, with spaces preserved.
4. WHEN a Turn begins, THE Game_Server SHALL start a countdown timer equal to the configured Turn duration.
5. WHEN the Turn timer expires, THE Game_Server SHALL end the current Turn, reveal the Word to all Players, and advance to the next Turn.
6. WHEN all Players have had one Turn as Drawer, THE Game_Server SHALL increment the Round counter and begin the next Round.
7. WHEN the final Round ends, THE Game_Server SHALL transition the Room to the Game Over state and broadcast the final scores to all Players.
8. THE Game_Server SHALL cycle through Players as Drawers in a consistent order across all Rounds.
9. WHEN a Turn ends, THE Game_Server SHALL broadcast the correct Word to all Players before advancing.

---

### Requirement 4: Word Hint Progression

**User Story:** As a guesser, I want to receive progressive hints over time, so that the game remains fair even if I can't guess quickly.

#### Acceptance Criteria

1. WHEN a Turn begins, THE Game_Server SHALL send an initial Hint with all non-space characters replaced by underscores.
2. WHEN 40% of the Turn duration has elapsed without a correct guess, THE Game_Server SHALL reveal one additional random unrevealed character in the Hint and broadcast the updated Hint to all Guessers.
3. WHEN 70% of the Turn duration has elapsed without a correct guess, THE Game_Server SHALL reveal one additional random unrevealed character in the Hint and broadcast the updated Hint to all Guessers.
4. THE Game_Server SHALL NOT send Hint updates to the current Drawer.
5. THE Game_Server SHALL NOT reveal the full Word through Hint progression; at least one character SHALL remain hidden until the Turn ends.

---

### Requirement 5: Drawing and Canvas Synchronization

**User Story:** As a drawer, I want my drawing to appear in real time on all other players' screens, so that everyone can see what I'm drawing.

#### Acceptance Criteria

1. WHILE a Player is the Drawer, THE Client SHALL capture pointer events (mouse and touch) on the Canvas and emit Stroke data to the Game_Server.
2. WHEN the Game_Server receives a Stroke event from the Drawer, THE Game_Server SHALL broadcast the Stroke data to all other Players in the Room.
3. WHEN a Client receives a Stroke broadcast, THE Client SHALL render the Stroke on the Canvas within 100ms of receipt.
4. THE Client SHALL support a minimum of 8 selectable brush colors.
5. THE Client SHALL support a minimum of 3 selectable brush sizes (small, medium, large).
6. WHEN the Drawer selects the fill tool and clicks a Canvas region, THE Client SHALL flood-fill that region with the selected color and broadcast the fill operation to the Game_Server.
7. WHEN the Drawer activates the eraser tool, THE Client SHALL treat pointer events as Strokes using the Canvas background color.
8. WHEN the Drawer clears the Canvas, THE Game_Server SHALL broadcast a clear-canvas event to all Players in the Room, and each Client SHALL reset the Canvas to its background color.
9. WHILE a Player is a Guesser, THE Client SHALL disable all drawing tools on the Canvas.
10. WHEN a new Player joins a Room mid-Lobby, THE Game_Server SHALL NOT send Canvas state, as drawing only occurs during active Turns.
11. WHEN a Turn begins, THE Game_Server SHALL broadcast a clear-canvas event to all Players so each Turn starts with a blank Canvas.

---

### Requirement 6: Guessing and Chat

**User Story:** As a guesser, I want to type guesses into a chat interface, so that I can try to identify the word being drawn.

#### Acceptance Criteria

1. WHILE a Player is a Guesser and a Turn is active, THE Client SHALL allow the Player to submit text messages as guesses.
2. WHEN a Guesser submits a guess that exactly matches the Word (case-insensitive), THE Game_Server SHALL mark that Guesser as having guessed correctly for the current Turn.
3. WHEN a Guesser guesses correctly, THE Game_Server SHALL broadcast a system message to all Players indicating the Guesser guessed the word, without revealing the Word itself.
4. WHEN a Guesser guesses correctly, THE Game_Server SHALL prevent that Guesser from submitting further guesses for the remainder of the current Turn.
5. WHEN a Guesser submits a guess that does not match the Word, THE Game_Server SHALL broadcast the guess as a chat message visible to all Players.
6. THE Game_Server SHALL NOT reveal the Word in any chat message broadcast to Guessers during an active Turn.
7. WHEN all Guessers have guessed correctly, THE Game_Server SHALL immediately end the current Turn.
8. WHILE a Player is the Drawer, THE Client SHALL allow the Player to send chat messages that are broadcast to all Players but SHALL NOT allow the Drawer to submit guesses.

---

### Requirement 7: Scoring

**User Story:** As a player, I want to earn points for guessing correctly and drawing well, so that the game is competitive.

#### Acceptance Criteria

1. WHEN a Guesser guesses the Word correctly, THE Game_Server SHALL award that Guesser a score using exponential decay with a position multiplier: `base_score = max(50, round(500 * (1 - elapsed/duration)^2))`, then `final_score = round(base_score * multiplier)` where the multiplier is 1.5 for the 1st correct guesser, 1.2 for the 2nd, 1.0 for the 3rd, and 0.9 for the 4th and subsequent guessers.
2. WHEN a Turn ends with at least one correct guess, THE Game_Server SHALL award the Drawer a bonus equal to the average of all correct Guessers' scores for that Turn, rounded to the nearest integer.
3. WHEN a Turn ends with zero correct guesses, THE Game_Server SHALL award the Drawer 0 bonus points for that Turn.
4. THE Game_Server SHALL broadcast the updated Score for each Player to all Players in the Room after each Turn ends.
5. THE Game_Server SHALL maintain cumulative Scores across all Rounds within a single game session.
6. WHEN the game ends, THE Game_Server SHALL broadcast the final ranked Score list to all Players.

---

### Requirement 8: Player Disconnection During Game

**User Story:** As a player, I want the game to handle disconnections gracefully, so that a single dropout doesn't ruin the session for everyone.

#### Acceptance Criteria

1. WHEN a Player disconnects during an active Turn and that Player is a Guesser, THE Game_Server SHALL mark the Player as disconnected and continue the Turn with the remaining Players.
2. WHEN the Drawer disconnects during an active Turn, THE Game_Server SHALL immediately end the current Turn, award 0 points for that Turn to all Players, and advance to the next Turn.
3. WHEN a Player disconnects and fewer than 2 connected Players remain in the Room, THE Game_Server SHALL start a 20-second countdown and broadcast a `waiting_for_reconnect` message to all remaining Players.
4. IF the disconnected Player reconnects within the 20-second countdown, THE Game_Server SHALL cancel the countdown, broadcast a `reconnect_resumed` message, and continue the game.
5. IF the 20-second countdown expires without reconnection, THE Game_Server SHALL end the game and broadcast a `game_ended_insufficient_players` message.
6. WHILE the 20-second countdown is active, THE Host SHALL be able to send an `end_game_now` message to immediately end the game without waiting for the countdown.
7. WHEN a Player disconnects, THE Game_Server SHALL broadcast the updated Player list to all remaining Players in the Room.
8. WHEN a disconnected Player reconnects to the same Room within 120 seconds using the same Room_Code and display name, THE Game_Server SHALL restore the Player's Score and player record, cancel the cleanup task, rejoin them to the Room, and broadcast a `player_reconnected` message.
9. WHILE a Player is disconnected, THE Game_Server SHALL award 0 points to that Player for any Turns or Rounds that occur during the disconnection period.
10. WHILE a Player is disconnected, THE Game_Server SHALL skip that Player when it would be their turn to draw.
11. IF a disconnected Player does not reconnect within 120 seconds, THEN THE Game_Server SHALL permanently remove the Player's record from the Room, including all associated data.

---

### Requirement 9: Game Over and Rematch

**User Story:** As a player, I want to see final results and have the option to play again, so that I can enjoy multiple sessions without leaving the room.

#### Acceptance Criteria

1. WHEN the game transitions to Game Over state, THE Client SHALL display the final ranked Score list for all Players.
2. WHEN the game transitions to Game Over state, THE Client SHALL display a rematch option to all Players.
3. WHEN the Host initiates a rematch, THE Game_Server SHALL reset all Player Scores to 0, reset the Round counter, reset used words and the word pool, and transition the Room back to Lobby state.
4. WHEN the Room transitions back to Lobby state for a rematch, THE Game_Server SHALL broadcast the Lobby state and reset configuration to all Players via a `rematch_started` message.
5. IF a non-Host Player attempts to initiate a rematch, THEN THE Game_Server SHALL reject the request and return a permission error.

---

### Requirement 10: Word List Management

**User Story:** As a host, I want the game to use a varied word list, so that the game stays fresh across multiple sessions.

#### Acceptance Criteria

1. THE Game_Server SHALL maintain a default word list of at least 200 words.
2. WHEN selecting a Word for a Turn, THE Game_Server SHALL select a word that has not been used in the current game session, until all words have been used, at which point THE Game_Server SHALL reshuffle and reuse the word list.
3. WHEN a Turn begins, THE Game_Server SHALL present the Drawer with a choice of 3 randomly selected Words from the word list.
4. WHEN the Drawer selects a Word from the 3 choices, THE Game_Server SHALL use that Word for the Turn.
5. IF the Drawer does not select a Word within 15 seconds, THE Game_Server SHALL automatically assign one of the 3 Words at random and begin the Turn.

---

### Requirement 11: Real-Time Communication Protocol

**User Story:** As a developer, I want a well-defined real-time communication protocol, so that the frontend and backend can interoperate reliably.

#### Acceptance Criteria

1. THE Game_Server SHALL use WebSocket connections for all real-time communication between Clients and the server.
2. WHEN a WebSocket connection is established, THE Game_Server SHALL associate the connection with a Player session.
3. WHEN a WebSocket connection drops unexpectedly, THE Game_Server SHALL treat the event as a Player disconnection and apply the disconnection rules defined in Requirement 8.
4. THE Game_Server SHALL send heartbeat pings to each connected Client every 30 seconds.
5. IF a Client does not respond to a heartbeat ping within 10 seconds, THEN THE Game_Server SHALL treat the Client as disconnected.
6. THE Game_Server SHALL serialize all WebSocket messages as JSON.
7. WHEN a Client sends a `reconnect` message with a matching name and room_code within the 120-second grace window, THE Game_Server SHALL restore the Player's session and send a `reconnected` response containing the full current game state (players, config, room state, hint, drawer, round).
8. THE Client SHALL store session information (player name, room code) in sessionStorage and attempt auto-reconnection on page refresh when on a game or lobby route.

---

### Requirement 12: Client User Interface

**User Story:** As a player, I want a clear and responsive game interface, so that I can focus on playing rather than navigating the UI.

#### Acceptance Criteria

1. THE Client SHALL display the current Room_Code prominently so Players can share it with others.
2. THE Client SHALL display the current Player list with each Player's display name, Score, and connection status.
3. THE Client SHALL display the current Round number and total number of Rounds.
4. THE Client SHALL display the Turn countdown timer, updated at least once per second.
5. THE Client SHALL display the current Hint to Guessers, updated whenever the Game_Server broadcasts a Hint update.
6. THE Client SHALL display the Canvas at a minimum resolution of 800×600 logical pixels.
7. THE Client SHALL render the game interface correctly on viewport widths between 360px and 1920px.
8. WHEN a Player correctly guesses the Word, THE Client SHALL visually distinguish that Player in the Player list for the remainder of the Turn.
9. THE Client SHALL display a drawing toolbar to the Drawer containing color picker, brush size selector, eraser, fill tool, and clear-canvas button.
10. WHEN the game transitions to Game Over state, THE Client SHALL display the final Score leaderboard with Player rankings.
11. WHEN a new Round begins, THE Client SHALL display a round transition animation indicating the current Round number and total Rounds.

---

### Requirement 13: Emoji Reactions

**User Story:** As a player, I want to react to drawings and guesses with emoji, so that I can express myself during the game.

#### Acceptance Criteria

1. THE Client SHALL provide a set of emoji reactions (👍 😂 🔥 ❤️ 👏 😮) that Players can send at any time during a game.
2. WHEN a Player sends a `reaction` message with an emoji, THE Game_Server SHALL broadcast the reaction (with player name and emoji) to all Players in the Room.
3. THE Client SHALL display received emoji reactions as system messages in the chat feed.

---

### Requirement 14: Multi-Worker Scaling

**User Story:** As a system administrator, I want to scale the application across multiple workers, so that the system can handle hundreds of concurrent players.

#### Acceptance Criteria

1. WHEN the `REDIS_URL` environment variable is set, THE Game_Server SHALL connect to Redis and use pub/sub for cross-worker message relay.
2. WHEN a broadcast is sent within a Room that may have players on different workers, THE Game_Server SHALL publish the message to a Redis channel so other workers can relay it to their local players.
3. THE Game_Server SHALL set a `worker_id` cookie on the first HTTP response to enable sticky session routing by the load balancer.
4. WHEN `REDIS_URL` is not set, THE Game_Server SHALL operate in single-worker mode with no Redis dependency.
5. THE nginx load balancer SHALL use `ip_hash` for initial routing and respect the `worker_id` cookie for subsequent requests.
6. THE nginx load balancer SHALL support WebSocket connections via HTTP/1.1 upgrade with long-lived timeouts (86400 seconds).
