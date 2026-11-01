import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { Tray } from './Tray.tsx';
import './styles.css';

const isTray = location.hash === '#tray';
createRoot(document.getElementById('root')!).render(isTray ? <Tray /> : <App />);
