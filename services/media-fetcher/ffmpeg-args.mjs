/** ffmpeg argv for isolated radio. Debian 5.1 httpproxy rejects TLS AVOptions. */
export function radioFfmpegArgs(url, { ca } = {}) {
  const https = /^https:/i.test(url);
  return [
    '-hide_banner', '-nostdin', '-v', 'error',
    '-protocol_whitelist', 'http,https,tls,tcp,httpproxy,crypto',
    // httpproxy (HTTP via the job shim) errors on -tls_verify / -ca_file.
    // HTTPS jobs, including later HLS/TLS hops from an HTTPS start, verify.
    ...(https ? ['-tls_verify', '1'] : []),
    ...(https && ca ? ['-ca_file', ca] : []),
    '-format_whitelist', 'hls,mpegts,mp3,aac,ogg,flac,wav,webm,mov,mp4,m4a',
    ...(url.includes('.m3u8') ? ['-allowed_extensions', 'ALL'] : []),
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-i', url,
    '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', '48000', '-ac', '2',
    'pipe:1',
  ];
}
