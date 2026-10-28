import type { DesktopPeerFactory } from '../../src/pdf/desktopDirectPeer.ts';
import type { PdfVersion } from '../../src/pdf/types.ts';

export const TEST_SDP = 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=sctp-port:5000\r\n';

export class FakeDesktopChannel extends EventTarget {
  binaryType = 'blob'; readyState = 'open'; bufferedAmount = 0; bufferedAmountLowThreshold = 0;
  sent: string[] = []; closed = 0;
  onSend?: (value: string) => void;
  send(value: string) { if (this.readyState !== 'open') throw new Error('closed synthetic channel'); this.sent.push(value); this.onSend?.(value); }
  close() { if (this.readyState === 'closed') return; this.closed++; this.readyState = 'closed'; this.dispatchEvent(new Event('close')); }
  receive(data: unknown) { this.dispatchEvent(new MessageEvent('message', { data })); }
  drain() { this.bufferedAmount = 0; this.dispatchEvent(new Event('bufferedamountlow')); }
}

export class FakeDesktopPeer extends EventTarget {
  channel = new FakeDesktopChannel();
  connectionState = 'new'; iceConnectionState = 'new'; iceGatheringState = 'complete';
  localDescription: RTCSessionDescriptionInit | null = null;
  sctp = { maxMessageSize: 65536 }; closed = 0;
  created: { label: string; options?: RTCDataChannelInit }[] = [];
  remote: RTCSessionDescriptionInit[] = [];
  offer: () => Promise<RTCSessionDescriptionInit> = async () => ({ type: 'offer', sdp: TEST_SDP });
  onAnswer?: () => void | Promise<void>;
  createOffer() { return this.offer(); }
  async setLocalDescription(description: RTCSessionDescriptionInit) { this.localDescription = description; }
  async setRemoteDescription(description: RTCSessionDescriptionInit) { this.remote.push(description); await this.onAnswer?.(); }
  createDataChannel(label: string, options?: RTCDataChannelInit) { this.created.push({ label, options }); return this.channel; }
  close() { if (this.connectionState === 'closed') return; this.closed++; this.connectionState = 'closed'; this.channel.close(); }
  fail() { this.connectionState = 'failed'; this.dispatchEvent(new Event('connectionstatechange')); }
  extraChannel() {
    const channel = new FakeDesktopChannel(); const event = new Event('datachannel');
    Object.defineProperty(event, 'channel', { value: channel }); this.dispatchEvent(event); return channel;
  }
  deliver(version: PdfVersion, requestId: string, bytes: Uint8Array) {
    this.channel.receive(JSON.stringify({ type: 'metadata', requestId, attachmentVersionId: version.entityId,
      sha256: version.data.sha256, sizeBytes: version.data.sizeBytes }));
    for (let offset = 0; offset < bytes.length; offset += 16384) this.channel.receive(bytes.slice(offset, offset + 16384).buffer);
    this.channel.receive(JSON.stringify({ type: 'eof', requestId, sha256: version.data.sha256, sizeBytes: version.data.sizeBytes }));
  }
}

export function fakeDesktopFactory(peer: FakeDesktopPeer, configurations: RTCConfiguration[] = []): DesktopPeerFactory {
  return (configuration) => { configurations.push(configuration); return peer as unknown as RTCPeerConnection; };
}

export function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export const flush = async () => { for (let count = 0; count < 30; count++) await Promise.resolve(); };
