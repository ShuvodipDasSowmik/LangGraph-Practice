import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Home from './Components/Home';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* App.jsx is used for routes only; Home is the main chat UI */}
        <Route path="/" element={<Home />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
