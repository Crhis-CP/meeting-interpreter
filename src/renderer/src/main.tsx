if (/Mac/.test(navigator.platform)) document.documentElement.classList.add('mac');
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(<App />);
