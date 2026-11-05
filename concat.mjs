// 把若干段 MediaRecorder 录的 mp4（H.264 + AAC）按顺序拼成一个 mp4，packet 级拷贝，不重新编码。
// 依赖 mediabunny 1.65.1（API 以 https://mediabunny.dev/guide/ 与 dist/mediabunny.d.ts 为准）。
import {
  Input,
  BlobSource,
  ALL_FORMATS,
  EncodedPacketSink,
  Output,
  Mp4OutputFormat,
  BufferTarget,
  EncodedVideoPacketSource,
  EncodedAudioPacketSource,
} from "https://cdn.jsdelivr.net/npm/mediabunny@1.65.1/dist/bundles/mediabunny.min.mjs";

const EPS = 1e-6;

/**
 * @param {Blob[]} blobs 按顺序的各段 mp4
 * @param {{ title?: string, portrait?: boolean }} [opts]
 *   title    写进输出文件的 metadata title
 *   portrait 第一段 rotation===0 且宽>高 时，强制按竖屏（rotation 90）写出
 * @returns {Promise<{ blob: Blob, durations: number[] }>} durations = 每段秒数（取该段视频/音频时长较大者）
 */
export async function concatTakes(blobs, opts = {}) {
  const { title, portrait = false } = opts;
  if (!Array.isArray(blobs) || blobs.length === 0) throw new Error("没有可拼接的片段");

  // ---- 第一遍：打开每段，读 track 信息并校验一致性 ----
  const segs = [];
  for (let i = 0; i < blobs.length; i++) {
    const n = i + 1;
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blobs[i]) });
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    if (!video) throw new Error(`第 ${n} 段没有视频轨`);

    const vCodec = await video.getCodec();
    if (!vCodec) throw new Error(`第 ${n} 段视频编码无法识别`);
    const vConfig = await video.getDecoderConfig();
    if (!vConfig) throw new Error(`第 ${n} 段视频缺少解码配置`);

    let aCodec = null;
    let aConfig = null;
    if (audio) {
      aCodec = await audio.getCodec();
      if (!aCodec) throw new Error(`第 ${n} 段音频编码无法识别`);
      aConfig = await audio.getDecoderConfig();
      if (!aConfig) throw new Error(`第 ${n} 段音频缺少解码配置`);
    }

    const seg = {
      n,
      input,
      video,
      audio,
      vCodec,
      vConfig,
      aCodec,
      aConfig,
      width: await video.getCodedWidth(),
      height: await video.getCodedHeight(),
      rotation: await video.getRotation(),
      vFirst: await video.getFirstTimestamp(),
      vDur: await video.computeDuration(),
      aFirst: audio ? await audio.getFirstTimestamp() : 0,
      aDur: audio ? await audio.computeDuration() : 0,
      sampleRate: audio ? await audio.getSampleRate() : 0,
      channels: audio ? await audio.getNumberOfChannels() : 0,
    };
    seg.duration = Math.max(seg.vDur, seg.aDur);
    segs.push(seg);
  }

  const first = segs[0];
  for (const s of segs.slice(1)) {
    if (s.vCodec !== first.vCodec) throw new Error(`第 ${s.n} 段视频编码不同（${s.vCodec} vs ${first.vCodec}），不能直接拼`);
    if (s.width !== first.width || s.height !== first.height) {
      throw new Error(`第 ${s.n} 段分辨率不同（${s.width}x${s.height} vs ${first.width}x${first.height}），不能直接拼`);
    }
    if (!!s.audio !== !!first.audio) throw new Error(`第 ${s.n} 段音轨有无与第 1 段不一致，不能直接拼`);
    if (s.audio) {
      if (s.aCodec !== first.aCodec) throw new Error(`第 ${s.n} 段音频编码不同（${s.aCodec} vs ${first.aCodec}），不能直接拼`);
      if (s.sampleRate !== first.sampleRate || s.channels !== first.channels) {
        throw new Error(`第 ${s.n} 段音频采样率/声道不同（${s.sampleRate}Hz ${s.channels}ch vs ${first.sampleRate}Hz ${first.channels}ch），不能直接拼`);
      }
    }
  }

  // rotation 取第一段；缺旋转标记且画面横着、调用方说是竖屏 → 90
  let rotation = first.rotation;
  if (rotation === 0 && first.width > first.height && portrait) rotation = 90;

  // ---- 建输出 ----
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: "in-memory" }),
    target: new BufferTarget(),
  });
  const videoSource = new EncodedVideoPacketSource(first.vCodec);
  output.addVideoTrack(videoSource, { rotation });
  let audioSource = null;
  if (first.audio) {
    audioSource = new EncodedAudioPacketSource(first.aCodec);
    output.addAudioTrack(audioSource);
  }
  if (title) output.setMetadataTags({ title });
  await output.start();

  // ---- 第二遍：逐段拷 packet，时间戳加偏移 ----
  let offset = 0;
  let vSent = false;
  let aSent = false;
  let vLastEnd = -Infinity;
  let aLastEnd = -Infinity;

  for (const s of segs) {
    // 第 1 段原样保留时间戳；后面的段把负起点（AAC priming）顶到 offset，避免和上一段末尾交叉
    const vShift = s === first ? 0 : offset - Math.min(s.vFirst, 0);
    const aShift = s === first ? 0 : offset - Math.min(s.aFirst, 0);

    // 视频
    {
      const sink = new EncodedPacketSink(s.video);
      let isFirstOfSeg = true;
      for await (const p of sink.packets()) {
        if (isFirstOfSeg) {
          if (p.type !== "key") throw new Error(`第 ${s.n} 段第一个视频包不是关键帧，不能直接拼`);
          isFirstOfSeg = false;
        }
        let ts = p.timestamp + vShift;
        if (p.type === "key" && ts < vLastEnd - EPS) ts = vLastEnd;
        const q = p.clone({ timestamp: ts });
        if (!vSent) {
          await videoSource.add(q, { decoderConfig: first.vConfig });
          vSent = true;
        } else {
          await videoSource.add(q);
        }
        vLastEnd = Math.max(vLastEnd, ts + p.duration);
      }
    }

    // 音频
    if (audioSource && s.audio) {
      const sink = new EncodedPacketSink(s.audio);
      for await (const p of sink.packets()) {
        let ts = p.timestamp + aShift;
        if (ts < aLastEnd - EPS) ts = aLastEnd;
        const q = p.clone({ timestamp: ts });
        if (!aSent) {
          await audioSource.add(q, { decoderConfig: first.aConfig });
          aSent = true;
        } else {
          await audioSource.add(q);
        }
        aLastEnd = Math.max(aLastEnd, ts + p.duration);
      }
    }

    offset += s.duration;
    s.input.dispose();
  }

  videoSource.close();
  if (audioSource) audioSource.close();
  await output.finalize();

  const buffer = output.target.buffer;
  if (!buffer) throw new Error("输出为空");
  return {
    blob: new Blob([buffer], { type: "video/mp4" }),
    durations: segs.map((s) => s.duration),
  };
}
