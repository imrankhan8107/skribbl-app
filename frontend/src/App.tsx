import { BrowserRouter, Routes, Route } from "react-router-dom";
import { VoiceChatProvider } from "./context/VoiceChatContext";
import Landing from "./pages/Landing";
import Lobby from "./pages/Lobby";
import Game from "./pages/Game";
import GameOver from "./pages/GameOver";

export default function App() {
  return (
    <BrowserRouter>
      <VoiceChatProvider>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/lobby/:roomCode" element={<Lobby />} />
          <Route path="/game/:roomCode" element={<Game />} />
          <Route path="/gameover/:roomCode" element={<GameOver />} />
        </Routes>
      </VoiceChatProvider>
    </BrowserRouter>
  );
}
