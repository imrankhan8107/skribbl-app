// Cypress support file loaded before each E2E spec.
// Ensure any lingering Player 2 WebSocket is closed after each test.
afterEach(() => {
  cy.task("p2Close", null, { log: false });
});
