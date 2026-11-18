'use strict';

class DebateGuestChannel {
  static maxFrame = 5_592_428;
  static maxMessage = 4 * 1024 * 1024;

  constructor(invite, onReady, onMessage, onClose) {
    this.socket = new WebSocket(invite.url);
    this.socket.binaryType = 'arraybuffer';
    this.encoder = new TextEncoder();
    this.decoder = new TextDecoder('utf-8', {fatal: true});
    this.buffer = '';
    this.sendCounter = 0n;
    this.receiveCounter = 0n;
    this.receiving = Promise.resolve();
    this.sending = Promise.resolve();
    this.closed = false;
    this.socket.onmessage = ({data}) => {
      this.receiving = this.receiving.then(async () => {
        if (this.closed) return;
        this.buffer += this.decoder.decode(data);
        let end;
        while (!this.closed && (end = this.buffer.indexOf('\n')) >= 0) {
          if (end > DebateGuestChannel.maxFrame) throw new Error('Sharing message exceeds the limit.');
          const frame = this.buffer.slice(0, end);
          this.buffer = this.buffer.slice(end + 1);
          const bytes = DebateGuestChannel.decode(frame);
          if (!this.receiveKey) {
            await this.handshake(invite.key, bytes);
            if (!this.closed) onReady();
          } else {
            const plaintext = await crypto.subtle.decrypt({name:'AES-GCM', iv:this.nonce(this.receiveCounter++)},
              this.receiveKey, bytes);
            if (plaintext.byteLength > DebateGuestChannel.maxMessage) throw new Error('Notebook is too large.');
            if (!this.closed) onMessage(JSON.parse(this.decoder.decode(plaintext)));
          }
        }
        if (this.buffer.length > DebateGuestChannel.maxFrame) throw new Error('Sharing message exceeds the limit.');
      }).catch(() => this.close());
    };
    this.socket.onclose = () => {
      this.closed = true;
      clearTimeout(this.timeout);
      onClose();
    };
    this.timeout = setTimeout(() => this.close(), 12000);
  }

  static decode(base64) {
    return Uint8Array.from(atob(base64), ch => ch.charCodeAt(0));
  }

  static encode(bytes) {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    }
    return btoa(binary);
  }

  async handshake(key, serverSalt) {
    if (serverSalt.length !== 32) throw new Error('Invalid host handshake.');
    const clientSalt = crypto.getRandomValues(new Uint8Array(32));
    const salt = new Uint8Array(64);
    salt.set(serverSalt);
    salt.set(clientSalt, 32);
    const secret = await crypto.subtle.importKey('raw', key, 'HKDF', false, ['deriveKey']);
    const derive = (direction, operation) => crypto.subtle.deriveKey(
      {name:'HKDF', hash:'SHA-256', salt, info:this.encoder.encode('debate-room-browser-v1/' + direction)},
      secret, {name:'AES-GCM', length:256}, false, [operation]);
    [this.sendKey, this.receiveKey] = await Promise.all([derive('guest','encrypt'), derive('host','decrypt')]);
    if (!this.closed) this.write(clientSalt);
    clearTimeout(this.timeout);
  }

  nonce(counter) {
    const nonce = new Uint8Array(12);
    new DataView(nonce.buffer).setBigUint64(4, counter);
    return nonce;
  }

  write(bytes) {
    const frame = this.encoder.encode(DebateGuestChannel.encode(bytes) + '\n');
    for (let offset = 0; offset < frame.length; offset += 65536) {
      this.socket.send(frame.subarray(offset, offset + 65536));
    }
  }

  send(message) {
    this.sending = this.sending.then(async () => {
      if (this.closed || !this.sendKey) return;
      const plaintext = this.encoder.encode(JSON.stringify(message));
      if (plaintext.length > DebateGuestChannel.maxMessage) throw new Error('Sharing message exceeds the limit.');
      const encrypted = await crypto.subtle.encrypt({name:'AES-GCM', iv:this.nonce(this.sendCounter++)},
        this.sendKey, plaintext);
      if (!this.closed) this.write(new Uint8Array(encrypted));
    }).catch(() => this.close());
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timeout);
    this.socket.close();
  }
}
