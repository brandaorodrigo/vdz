'use strict';

class VdzLoopback extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.buffered = 0;
    this.target = Math.round(sampleRate * 0.06);
    this.high = Math.round(sampleRate * 0.12);
    this.lastLeft = 0;
    this.lastRight = 0;
    this.port.onmessage = (event) => {
      const data = event.data;
      if (!data || !data.length || data.length % 2 !== 0) return;
      this.queue.push(data);
      this.buffered += data.length / 2;
      this.trim();
    };
  }

  trim() {
    while (this.buffered > this.high && this.queue.length) {
      const extra = this.buffered - this.target;
      const head = this.queue[0];
      const available = (head.length - this.offset) / 2;
      if (available <= extra) {
        this.buffered -= available;
        this.queue.shift();
        this.offset = 0;
      } else {
        this.offset += extra * 2;
        this.buffered -= extra;
      }
    }
  }

  pull() {
    while (this.queue.length && this.offset >= this.queue[0].length) {
      this.queue.shift();
      this.offset = 0;
    }
    if (!this.queue.length) return null;
    const head = this.queue[0];
    const left = head[this.offset++];
    const right = head[this.offset++];
    this.buffered -= 1;
    return [left, right];
  }

  process(_inputs, outputs) {
    const channels = outputs[0];
    const left = channels[0];
    const right = channels[1] || left;
    if (!left) return true;
    for (let i = 0; i < left.length; i++) {
      const frame = this.buffered > 0 ? this.pull() : null;
      if (frame) {
        this.lastLeft = frame[0];
        this.lastRight = frame[1];
      }
      left[i] = this.lastLeft;
      right[i] = this.lastRight;
    }
    return true;
  }
}

registerProcessor('vdz-loopback', VdzLoopback);
