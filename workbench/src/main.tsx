import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import DeliveryApp from './DeliveryApp';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode>{window.location.pathname.startsWith('/delivery') ? <DeliveryApp /> : <App />}</React.StrictMode>);
