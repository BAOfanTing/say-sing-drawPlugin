// 「把一段话读成语音条」的合成流水线：情绪解析 → 切句 → 逐句合成 → 音区守门 →
// 音高归一 → 情绪后期加工 → 拼回一条。
//
// 为什么单独一个模块：这块约 130 行，和点歌流水线共享状态（voiceOptions / tempFiles /
// armLocalIdle），挤在同一个 1000 行闭包里，改说话要先把搜歌换声那 300 行读完。
// 抽出来时把共享面收成**显式入参**，不持有闭包状态：
//   · voiceOptions 由调用方算好传进来（情绪 → 表演指令）
//   · tempFiles 由本模块自己管（谁创建谁清理，返回清理函数）
//   · armLocalIdle 由调用方以回调传入（说完开始闲置倒计时）
//
// 它**不**负责 HTTP：返回 { buffer, contentType, seconds, wasTruncated, sayMaxChars, cleanup }，
// 路由层自己 writeHead/end。这样测试可以直接调 synthesize 而不用起 HTTP。
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {object} deps
 * @param {object} deps.config          需要 config.say（maxChars/splitSentences/maxSegmentChars/…）
 * @param {object} deps.say             say 引擎（convert）
 * @param {object} deps.gpu             createGpuSlot() 出来的槽位（本地 TTS 落地要占槽）
 * @param {Function} deps.resumeLocalSay 确保本地 TTS 在跑（返回 bool）
 * @param {Function} deps.pitchNormalize 音高归一（返回新路径）
 * @param {Function} deps.synthesizeInRegister 音区守门合成
 * @param {Function} deps.splitSayText   切句
 * @param {Function} deps.concatAudio    拼接
 * @param {Function} deps.probeSeconds   探时长
 * @param {Function} deps.applyFilter    情绪 ffmpeg 加工（返回 bool）
 * @param {Function} [deps.parseEmotionTag] 解析文字里的【情绪】标记
 * @param {Function} [deps.resolveEmotionKey]
 * @param {Function} [deps.emotionInstruction]
 * @param {Function} deps.now
 * @param {Function} deps.log
 */
export function createSaySpeech({
  config,
  say,
  gpu,
  resumeLocalSay,
  pitchNormalize,
  synthesizeInRegister,
  splitSayText,
  concatAudio,
  probeSeconds,
  applyFilter,
  parseEmotionTag = null,
  resolveEmotionKey = null,
  emotionInstruction = null,
  now = () => Date.now(),
  log = (msg) => console.log(msg)
}) {
  const sayConfig = config?.say || {};

  /**
   * 合成一条语音。抛错时调用方负责回 4xx/5xx；返回的 cleanup() 一定要调（删临时文件）。
   * @returns {Promise<{buffer, contentType, seconds, chars, wasTruncated, sayMaxChars, cleanup}>}
   */
  const synthesize = async (text, options = {}) => {
    const startedAt = now();
    const emotionTable = sayConfig.emotions || {};
    // 文字里的标记优先于 body.emotion：模型写的比调用方猜的更贴身
    const tagged = sayConfig.emotionTag !== false && parseEmotionTag
      ? parseEmotionTag(text, emotionTable)
      : { emotion: '', text };
    const askedEmotion = tagged.emotion
      || (resolveEmotionKey ? resolveEmotionKey(options.emotion, emotionTable) : '');
    const preset = askedEmotion ? emotionTable[askedEmotion] : null;
    const speakText = String(tagged.text ?? '');
    const voiceOptions = preset && emotionInstruction
      ? {
        instructions: emotionInstruction(sayConfig.instructions, preset),
        boost: preset.boost !== false
      }
      : {};
    if (preset) log(`[say] 情绪=${askedEmotion}（${preset.label || ''}）`);

    // 截断要留痕：以前静默截断，长回复后半段被丢掉、模型完全不知道
    const sayMaxChars = Math.max(20, Number(sayConfig.maxChars) || 800);
    const wasTruncated = String(speakText ?? '').replace(/\s+/g, ' ').trim().length > sayMaxChars;

    const chunks = sayConfig.splitSentences
      ? splitSayText(speakText, Number(sayConfig.maxSegmentChars) || 30)
      : [String(speakText ?? '')];

    const tempFiles = [];
    const cleanup = () => {
      for (const file of new Set(tempFiles)) {
        try { fs.rmSync(file, { force: true }); } catch { /* 忽略 */ }
      }
    };

    let spoke;
    /** 真正合成的部分（不含"要不要占 GPU 槽"那层决策）。 */
    const synthesizeAll = async () => {
      try {
        if (chunks.length > 1) {
          log(`[say] 切成 ${chunks.length} 句逐句合成（避免音高漂移）`);
          const parts = [];
          for (let i = 0; i < chunks.length; i += 1) {
            const partRaw = path.join(options.tmpDir, `say-${now()}-${i}.wav`);
            const part = await synthesizeInRegister(chunks[i], partRaw, 42, voiceOptions);
            tempFiles.push(part.file);
            let normalizedPart = part.file;
            if (part.via !== 'cloud') {
              normalizedPart = await pitchNormalize(part.file);
              if (normalizedPart !== part.file) tempFiles.push(normalizedPart);
            }
            parts.push(normalizedPart);
          }
          const merged = path.join(options.tmpDir, `say-${now()}-merged.wav`);
          const ok = await concatAudio(parts, merged, { ext: 'wav' });
          if (!ok) throw Object.assign(new Error('分段合成后拼接失败'), { code: 'E_SAY_CONCAT' });
          tempFiles.push(merged);
          return { file: merged, bytes: fs.statSync(merged).size, chars: speakText.length, format: 'wav' };
        }
        {
          const raw = path.join(options.tmpDir, `say-${now()}.wav`);
          // 先把目标文件登记进清理列表：convert 可能写了一半再抛错，失败路径也得删干净
          tempFiles.push(raw);
          try {
            spoke = await synthesizeInRegister(speakText, raw, 42, voiceOptions);
          } catch (error) {
            // auto：云端挂了才落本地。**必须先拿到 GPU 槽** —— 本地 TTS 要 8.2 GB，
            // 画图/唱歌正在跑的时候硬拉起来就是两个一起掉进共享内存，宁可让宿主退回文字。
            if (sayConfig.engine !== 'auto') throw error;
            spoke = await gpu.run('say', async () => {
              const prepared = await resumeLocalSay();
              if (!prepared) throw error;
              return await synthesizeInRegister(speakText, raw, 42, voiceOptions);
            });
          }
          tempFiles.push(spoke.file);
          // 云端输出保持原样（那是官方音色，改音高反而会走味）
          if (spoke.via !== 'cloud') {
            const normalized = await pitchNormalize(spoke.file);
            if (normalized !== spoke.file) { tempFiles.push(normalized); spoke.file = normalized; }
          }
          spoke.format = /mp3$/i.test(spoke.file) ? 'mp3' : spoke.format;
          return spoke;
        }
      } catch (error) {
        const code = String(error?.code || 'E_SAY');
        cleanup();
        // 401/额度类错误原样带出去：使用者最需要知道的是"Key 不对"还是"没钱了"
        throw Object.assign(
          new Error(`读这段话失败：${String(error?.message ?? error).slice(0, 240)}`),
          { code }
        );
      }
    };

    // 本地 TTS 要 8.2 GB：breeze-local 必然要占槽；auto 只在云端失败那一刻才占（见上面的 catch）
    if (sayConfig.engine === 'breeze-local') {
      spoke = await gpu.run('say', async () => {
        await resumeLocalSay();          // 拿到槽位之后才把本地模型拉起来
        return await synthesizeAll();
      });
    } else {
      spoke = await synthesizeAll();
    }

    // 情绪后期加工：合成时已经带了表演指令，这里再补响度/节奏/硬度。
    // ffmpeg 只动响度和时间尺度、不动音高，所以音色不受影响；
    // 失败（没 ffmpeg / 滤镜写错）就发未加工的版本，别为了一点音色把语音整单搞死。
    if (preset?.filter) {
      const ext = /mp3$/i.test(spoke.file) ? 'mp3' : 'wav';
      const filtered = path.join(options.tmpDir, `say-${now()}-emo.${ext}`);
      const filteredOk = await applyFilter(spoke.file, filtered, preset.filter, { ext });
      if (filteredOk && fs.existsSync(filtered)) {
        tempFiles.push(filtered);
        spoke = { ...spoke, file: filtered, bytes: fs.statSync(filtered).size, format: ext };
      } else {
        log('[say] 情绪加工没跑成（ffmpeg 不可用或滤镜不合法），发未加工的音频');
      }
    }

    const buffer = fs.readFileSync(spoke.file);
    tempFiles.push(spoke.file);
    const contentType = spoke.format === 'wav' ? 'audio/wav'
      : spoke.format === 'mp3' ? 'audio/mpeg'
        : spoke.format === 'opus' ? 'audio/ogg' : 'application/octet-stream';
    const probed = Math.round(await probeSeconds(spoke.file)) || 0;
    // 探不到时长就按中文语速估（约 4.5 字/秒），别报 0 让宿主又说"才一秒"
    const seconds = probed > 0 ? probed : Math.max(1, Math.round(spoke.chars / 4.5));
    log(`[say] ${spoke.chars} 字 → ${seconds} 秒（${Math.round(buffer.length / 1024)} KB，${now() - startedAt}ms）`);
    if (wasTruncated) log(`[say] 文本超过 say.maxChars=${sayMaxChars}，后半段已被丢弃`);

    return { buffer, contentType, seconds, chars: spoke.chars, wasTruncated, sayMaxChars, cleanup };
  };

  return { synthesize };
}
