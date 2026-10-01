/**
 * WebRTC Video Player — connects to the sidecar via the backend proxy
 * to display a live preview of the video stream in the WebUI.
 */

import { useRef, useEffect, useCallback, useState } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { musicBotsApi } from '@/api/music.api';
import {
  PREVIEW_ICE_TIMEOUT_MS,
  offerAdvertisesLoopbackOnly,
  previewIceErrorMessage,
} from '@/lib/preview-webrtc';

interface VideoPlayerProps {
  botId: number;
  streaming: boolean;
  /** Shown when idle instead of the default “No active video stream”. */
  idleDetail?: string | null;
  className?: string;
}

export function VideoPlayer({ botId, streaming, idleDetail, className }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const iceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Starts muted so autoplay isn't blocked; unmute to check whether audio
  // issues are server-side (present here too) or specific to the TS client.
  const [muted, setMuted] = useState(true);

  const clearIceTimer = useCallback(() => {
    if (iceTimerRef.current != null) {
      clearTimeout(iceTimerRef.current);
      iceTimerRef.current = null;
    }
  }, []);

  const cleanup = useCallback(() => {
    clearIceTimer();
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    setConnected(false);
  }, [clearIceTimer]);

  const connect = useCallback(async () => {
    cleanup();
    setError(null);

    try {
      // Get SDP offer from backend (which gets it from sidecar)
      const { sdp: offerSdp } = await musicBotsApi.webrtcOffer(botId);

      // Note loopback-only host candidates for failure guidance. Do not reject
      // early based on the page hostname — a same-host browser opened via a
      // LAN/proxy name can still reach 127.0.0.1 on that machine (#202 CR).
      const loopbackOnlyOffer = offerAdvertisesLoopbackOnly(offerSdp);

      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      });
      pcRef.current = pc;

      // Hold local candidates until the answer is accepted. Trickling ICE
      // before SetAnswer makes Pion reject host candidates (#202).
      const pendingIce: RTCIceCandidate[] = [];
      let answerReady = false;

      const sendIce = async (candidate: RTCIceCandidate) => {
        try {
          await musicBotsApi.webrtcIce(
            botId,
            candidate.candidate,
            candidate.sdpMid || '0',
            candidate.sdpMLineIndex ?? 0,
          );
        } catch {
          /* ignore ICE errors */
        }
      };

      const failIce = (kind: 'failed' | 'timeout') => {
        if (pcRef.current !== pc) return;
        clearIceTimer();
        setConnected(false);
        setError(
          previewIceErrorMessage(loopbackOnlyOffer ? 'loopback-mismatch' : kind),
        );
        pc.close();
        if (pcRef.current === pc) pcRef.current = null;
      };

      pc.ontrack = (ev) => {
        if (videoRef.current && ev.streams[0]) {
          videoRef.current.srcObject = ev.streams[0];
        }
      };

      pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        if (state === 'connected' || state === 'completed') {
          clearIceTimer();
          setConnected(true);
          setError(null);
        } else if (state === 'failed') {
          failIce('failed');
        } else if (state === 'disconnected' || state === 'closed') {
          setConnected(false);
        }
      };

      pc.onicecandidate = (ev) => {
        if (!ev.candidate) return;
        if (!answerReady) {
          pendingIce.push(ev.candidate);
          return;
        }
        void sendIce(ev.candidate);
      };

      // Set remote offer
      await pc.setRemoteDescription(new RTCSessionDescription({
        type: 'offer',
        sdp: offerSdp,
      }));

      // Create and send answer before flushing buffered ICE candidates
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await musicBotsApi.webrtcAnswer(botId, answer.sdp!);

      // Arm the ICE timeout as soon as the answer is accepted so a slow
      // pendingIce sendIce() flush cannot stretch past the deadline.
      // Stale connect() after cleanup/remount must not clear a newer timer.
      if (pcRef.current !== pc) return;
      clearIceTimer();
      iceTimerRef.current = setTimeout(() => {
        if (pcRef.current !== pc) return;
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          return;
        }
        // Browsers often stay in ICE "checking" forever when candidates are
        // unreachable (e.g. NAT1TO1=127.0.0.1 for a remote client).
        failIce('timeout');
      }, PREVIEW_ICE_TIMEOUT_MS);

      answerReady = true;
      for (const candidate of pendingIce) {
        await sendIce(candidate);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to connect');
      cleanup();
    }
  }, [botId, cleanup, clearIceTimer]);

  useEffect(() => {
    if (streaming) {
      // Small delay to ensure sidecar is ready
      const timer = setTimeout(connect, 500);
      return () => {
        clearTimeout(timer);
        cleanup();
      };
    } else {
      cleanup();
    }
  }, [streaming, connect, cleanup]);

  if (!streaming) {
    return (
      <div className={`flex flex-col items-center justify-center gap-1 bg-black/50 rounded-lg aspect-video max-w-xl px-4 text-center ${className ?? ''}`}>
        <p className="text-muted-foreground text-sm">No active video stream</p>
        {idleDetail && (
          <p className="text-xs text-destructive/90 line-clamp-3">{idleDetail}</p>
        )}
      </div>
    );
  }

  return (
    <div className={`relative rounded-lg overflow-hidden bg-black aspect-video max-w-xl ${className ?? ''}`}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={muted}
        className="w-full h-full object-contain"
      />
      {!connected && !error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70">
          <p className="text-white text-sm animate-pulse">Connecting to stream...</p>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 gap-2 px-4 text-center">
          <p className="text-red-400 text-sm">{error}</p>
          <button
            onClick={connect}
            className="text-xs text-blue-400 hover:text-blue-300 underline"
          >
            Retry
          </button>
        </div>
      )}
      {connected && (
        <>
          <div className="absolute top-2 right-2 flex items-center gap-1.5 bg-black/60 px-2 py-1 rounded text-xs">
            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            <span className="text-white">LIVE</span>
          </div>
          <button
            type="button"
            onClick={() => setMuted((m) => !m)}
            className="absolute bottom-2 right-2 rounded bg-black/60 p-1.5 text-white hover:bg-black/80"
            title={muted ? 'Unmute preview' : 'Mute preview'}
          >
            {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>
        </>
      )}
    </div>
  );
}
