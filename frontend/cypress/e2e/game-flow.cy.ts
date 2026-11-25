describe("Skribbl E2E Game Flow", () => {
  it("loads the landing page and handles invalid room codes gracefully", () => {
    cy.visit("/");
    cy.contains("Create Room").should("be.visible");

    cy.get('input[placeholder="Enter your name"]').type("Tester");
    cy.get('input[placeholder="Enter room code to join"]').type("ZZZZZZ");
    cy.contains("button", "Join Room").click();

    // Should stay on landing / show error rather than crashing
    cy.url().should("eq", `${Cypress.config("baseUrl")}/`);
  });

  it("runs a 2-player game: create room, join, select word, draw binary strokes without disconnecting, guess, and finish", () => {
    cy.visit("/");
    // Allow initial WebSocket handshake to 127.0.0.1:8000 to reach OPEN state
    cy.wait(400);

    // 1. Player 1 creates a room
    cy.get('input[placeholder="Enter your name"]').type("Alice");
    cy.contains("button", "Create Room").click();

    cy.url().should("include", "/lobby/");
    cy.get('[data-testid="room-code"]')
      .invoke("text")
      .then((rawCode) => {
        const roomCode = rawCode.trim().match(/[A-Z0-9]{6}/)?.[0] ?? "";
        expect(roomCode).to.have.length(6);

        // 2. Player 2 connects via real WebSocket and joins the same room
        cy.task("p2Connect", "ws://127.0.0.1:8000/ws");
        cy.task("p2Send", {
          type: "join_room",
          payload: { name: "Bob", room_code: roomCode },
        });
        cy.task("p2WaitForEvent", { type: "room_joined" });

        // Player 1 sees Bob in the lobby
        cy.contains("Bob").should("be.visible");

        // 3. Host starts the game
        cy.contains("button", /Start Game/i).click();
        cy.url().should("include", `/game/${roomCode}`);
        cy.task("p2WaitForEvent", { type: "game_started" });

        // 4. Drawer (Alice) selects the first word choice
        cy.get('[data-testid="word-choices"] button')
          .first()
          .invoke("text")
          .then((wordText) => {
            const chosenWord = wordText.trim();
            cy.get('[data-testid="word-choices"] button').first().click();

            cy.task("p2WaitForEvent", { type: "turn_started" });

            // 5. Alice draws on the canvas — sends binary WebSocket frames
            cy.get('[data-testid="drawing-canvas"]')
              .should("be.visible")
              .then(($canvas) => {
                const rect = $canvas[0].getBoundingClientRect();
                const startX = rect.left + rect.width * 0.3;
                const startY = rect.top + rect.height * 0.4;

                cy.wrap($canvas)
                  .trigger("mousedown", {
                    clientX: startX,
                    clientY: startY,
                    button: 0,
                    force: true,
                  })
                  .trigger("mousemove", { clientX: startX + 40, clientY: startY + 25, force: true })
                  .trigger("mousemove", { clientX: startX + 80, clientY: startY + 10, force: true })
                  .trigger("mouseup", { force: true });
              });

            // 6. Verify Player 2 received the binary stroke frame and stayed connected
            cy.task("p2WaitForBinary").then((bytes) => {
              const arr = bytes as number[];
              expect(arr.length).to.be.greaterThan(5);
              // Opcode 0x01 (STROKE) or 0x04 (HIGHLIGHTER)
              expect([0x01, 0x04]).to.include(arr[0]);
            });

            cy.task("p2Status").then((status) => {
              const s = status as { closed: boolean; eventsReceived: string[] };
              expect(s.closed).to.eq(false);
              expect(s.eventsReceived).to.not.include("game_ended_insufficient_players");
            });

            // Alice must still be on /game/:roomCode, NOT redirected to /gameover
            cy.url().should("include", `/game/${roomCode}`);

            // 7. Player 2 guesses the word correctly -> Turn 1 ends cleanly
            cy.task("p2Send", {
              type: "guess",
              payload: { text: chosenWord },
            });
            cy.task("p2WaitForEvent", { type: "guess_correct" });

            // 8. Turn 1 ends, Turn 2 begins with Bob as drawer -> Alice guesses via UI
            cy.task("p2WaitForEvent", { type: "turn_ended" });
            cy.task("p2WaitForEvent", { type: "word_choices" }).then((evt) => {
              const wc = evt as { payload?: { choices?: string[] } };
              const bobWord = wc.payload?.choices?.[0] ?? "";
              expect(bobWord).to.not.be.empty;

              cy.task("p2Send", {
                type: "select_word",
                payload: { word: bobWord },
              });
              cy.task("p2WaitForEvent", { type: "turn_started" });

              // Alice (guesser) sees hint and submits the correct guess in chat
              cy.get('[data-testid="hint-display"]').should("be.visible");
              cy.get('[data-testid="chat-input"]').type(`${bobWord}{enter}`);
              cy.task("p2WaitForEvent", { type: "guess_correct" });
            });

            // 9. Bob disconnects -> Host sees reconnect banner and clicks End Game Now -> /gameover
            cy.task("p2Close");
            cy.get('[data-testid="end-game-now-btn"]').should("be.visible").click();
            cy.url().should("include", `/gameover/${roomCode}`);
            cy.contains("h1", "Game Over").should("be.visible");
          });
      });
  });
});
