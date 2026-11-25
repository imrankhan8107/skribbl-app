describe("Skribbl Social, Password & Spectator E2E", () => {
  it("enforces private room password and saves custom word packs in the lobby", () => {
    cy.visit("/");
    cy.wait(400);

    // 1. Create a private room with a password
    cy.get('input[placeholder="Enter your name"]').type("LockHost");
    cy.get('[data-testid="room-password-input"]').type("secret123");
    cy.contains("button", "Create Room").click();

    cy.url().should("include", "/lobby/");
    cy.get('[data-testid="private-room-indicator"]').should("be.visible");
    cy.get('[data-testid="room-privacy-status"]').should("contain.text", "Private");

    cy.get('[data-testid="room-code"]')
      .invoke("text")
      .then((rawCode) => {
        const roomCode = rawCode.trim().match(/[A-Z0-9]{6}/)?.[0] ?? "";
        expect(roomCode).to.have.length(6);

        // 2. Player 2 tries joining without password -> rejected with error
        cy.task("p2Connect", "ws://127.0.0.1:8000/ws");
        cy.task("p2Send", {
          type: "join_room",
          payload: { name: "Intruder", room_code: roomCode },
        });
        cy.task("p2WaitForEvent", { type: "error" });

        // 3. Player 2 joins with the correct password -> succeeds
        cy.task("p2Send", {
          type: "join_room",
          payload: { name: "TrustedFriend", room_code: roomCode, password: "secret123" },
        });
        cy.task("p2WaitForEvent", { type: "room_joined" });
        cy.contains("TrustedFriend").should("be.visible");

        // 4. Host saves custom words and Player 2 receives settings_updated
        cy.get('[data-testid="custom-words-textarea"]').type("pikachu, charizard, bulbasaur");
        cy.get('[data-testid="save-custom-words-btn"]').click();

        cy.get('[data-testid="custom-words-count"]').should("contain.text", "3");
        cy.task("p2WaitForEvent", { type: "settings_updated" }).then((evt) => {
          const msg = evt as { payload?: { config?: { custom_words?: string[] } } };
          expect(msg.payload?.config?.custom_words).to.include("pikachu");
        });
      });
  });

  it("allows joining a room as a spectator and displays the spectator banner", () => {
    // Player 2 (Node ws) creates a room first
    cy.task("p2Connect", "ws://127.0.0.1:8000/ws");
    cy.task("p2Send", {
      type: "create_room",
      payload: { name: "RoomOwner" },
    });

    cy.task("p2WaitForEvent", { type: "room_created" }).then((evt) => {
      const msg = evt as { payload?: { room_code?: string } };
      const roomCode = msg.payload?.room_code ?? "";
      expect(roomCode).to.have.length(6);

      cy.visit("/");
      cy.wait(400);

      cy.get('input[placeholder="Enter your name"]').type("Watcher");
      cy.get('input[placeholder="Enter room code to join"]').type(roomCode);
      cy.get('[data-testid="spectator-checkbox"]').check();
      cy.contains("button", "Join Room").click();

      cy.url().should("include", `/lobby/${roomCode}`);
      cy.get('[data-testid="spectator-banner"]').should("be.visible");
    });
  });
});
