import { io } from 'socket.io-client';

let socket = null;

export function getSocket() {
  if (!socket) {
    const token = localStorage.getItem('token');
    socket = io('/', {
      auth: { token },
      autoConnect: true,
    });

    socket.on('connect', () => console.log('[socket] connected', socket.id));
    socket.on('disconnect', () => console.log('[socket] disconnected'));
    socket.on('connect_error', (err) => console.warn('[socket] error', err.message));
  }
  return socket;
}

export function closeSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
