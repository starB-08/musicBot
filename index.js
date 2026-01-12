//@ts-nocheck
require("./keepAlive");
const { Client, Events, GatewayIntentBits } = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  getVoiceConnection,
  StreamType,
} = require("@discordjs/voice");

const youtubedl = require("youtube-dl-exec");
const { token } = require("./config.json");
const prism = require("prism-media");
const ffmpeg = require("ffmpeg-static");

/* ===================== client ===================== */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

/* ===================== prefix ===================== */
const prefixes = new Map();
const DEFAULT_PREFIX = ".";

/* ===================== music state ===================== */
const queues = new Map();

/* ===================== ready ===================== */
client.once(Events.ClientReady, () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

/* ===================== message ===================== */
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;

  const guildId = message.guild.id;
  const prefix = prefixes.get(guildId) || DEFAULT_PREFIX;
  if (!message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/ +/);
  const command = args.shift()?.toLowerCase();

  /* ===================== setprefix ===================== */
  if (["setprefix", "prefix"].includes(command)) {
    const newPrefix = args[0];
    if (!newPrefix) return message.reply("prefix를 입력해.");
    if (newPrefix.length > 3)
      return message.reply("prefix는 3자 이하만 가능해.");

    prefixes.set(guildId, newPrefix);
    return message.reply(`✅ prefix 변경됨 → \`${newPrefix}\``);
  }

  /* ===================== init ===================== */
  if (!queues.has(guildId)) {
    queues.set(guildId, {
      queue: [],
      current: null,
      player: createAudioPlayer({
        behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
      }),
      connection: null,
      volume: 0.5,
      repeat: false, // repeat all
    });
  }

  const data = queues.get(guildId);

  /* ===================== play ===================== */
  if (["play", "재생"].includes(command)) {
    const query = args.join(" ");
    if (!query) return message.reply("제목이나 URL을 입력하십시오.");

    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel)
      return message.reply("음성 채널에 들어가 있지 않습니다.");

    if (!data.connection) {
      data.connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId,
        adapterCreator: message.guild.voiceAdapterCreator,
      });
      data.connection.subscribe(data.player);

      data.player.on(AudioPlayerStatus.Idle, () => {
        playNext(guildId, message);
      });

      data.player.on("error", (err) => {
        console.error("❌ Player error:", err);
        playNext(guildId, message);
      });
    }

    try {
      message.channel.send("🔍 검색 중...");

      const urlPattern = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/;
      const isUrl = urlPattern.test(query);

      let info;
      if (isUrl) {
        info = await youtubedl(query, { dumpSingleJson: true });
      } else {
        const search = await youtubedl(`ytsearch1:${query}`, {
          dumpSingleJson: true,
        });
        if (!search.entries || search.entries.length === 0) {
          throw new Error("검색 결과 없음");
        }
        info = search.entries[0];
      }

      const song = {
        title: info.title,
        url: info.webpage_url || info.url,
        duration: Math.floor(info.duration || 0),
      };

      data.queue.push(song);

      const d = `${Math.floor(song.duration / 60)}:${String(
        song.duration % 60
      ).padStart(2, "0")}`;

      message.reply(`🎵 **${song.title}** (${d}) 추가됨`);

      if (data.player.state.status !== AudioPlayerStatus.Playing) {
        playNext(guildId, message);
      }
    } catch (err) {
      console.error(err);
      message.reply("이 영상은 재생할 수 없습니다.");
    }
  }

  /* ===================== queue ===================== */
  if (["queue", "목록"].includes(command)) {
    let text = "**📋 재생 목록**\n";

    if (data.current) {
      text += `> ▶️ **${data.current.title}** (재생 중)\n`;
    }

    if (data.queue.length === 0) {
      text += "> (대기열 비어있음)\n";
    } else {
      data.queue.forEach((s, i) => {
        const d = `${Math.floor(s.duration / 60)}:${String(
          s.duration % 60
        ).padStart(2, "0")}`;
        text += `> ${i + 1}. **${s.title}** (${d})\n`;
      });
    }

    if (data.repeat) text += "\n🔁 repeat: ON";

    message.reply(text);
  }

  /* ===================== repeat ===================== */
  if (["repeat", "반복"].includes(command)) {
    data.repeat = !data.repeat;
    message.reply(data.repeat ? "🔁 repeat ON (전체 순환)" : "➡️ repeat OFF");
  }

  /* ===================== skip ===================== */
  if (["skip", "스킵", "건너뛰기"].includes(command)) {
    data.player.stop(true);
    message.reply("⏭ 스킵");
  }

  /* ===================== stop ===================== */
  if (["stop", "정지"].includes(command)) {
    data.queue = [];
    data.current = null;
    data.repeat = false;
    data.player.stop();

    const conn = getVoiceConnection(guildId);
    if (conn) conn.destroy();

    queues.delete(guildId);
    message.reply("⏹ 재생 중지");
  }

  /* ===================== volume ===================== */
  if (["volume", "볼륨"].includes(command)) {
    const v = Number(args[0]);
    if (isNaN(v) || v < 0 || v > 1)
      return message.reply("0 ~ 1 사이 숫자만 가능해.");

    data.volume = v;

    const resource = data.player.state.resource;
    if (resource?.volume) {
      resource.volume.setVolume(v);
    }
    message.reply(`🔊 볼륨 ${Math.round(v * 100)}%`);
  }

  /* ===================== remove ===================== */
  if (["remove", "삭제", "제거"].includes(command)) {
    const idx = Number(args[0]) - 1;
    if (isNaN(idx) || !data.queue[idx]) return message.reply("잘못된 번호");

    const [removed] = data.queue.splice(idx, 1);
    message.reply(`❌ **${removed.title}** 제거됨`);
  }
  /* ===================== help ===================== */
  if (["help", "도움말"].includes(command)) {
    const text = `
📖 **명령어 목록**

> ${
      prefixes.get(guildId) || "."
    }play/재생 [곡 이름]/[곡 URL] : 곡 재생 및 대기열 추가
> ${prefixes.get(guildId) || "."}skip/스킵/건너뛰기 : 현재 곡 스킵
> ${prefixes.get(guildId) || "."}stop/정지 : 재생 중지 및 초기화
> ${prefixes.get(guildId) || "."}repeat/반복 : 전체 반복 ON / OFF
> ${prefixes.get(guildId) || "."}queue/목록 : 현재 재생 목록 표시
> ${prefixes.get(guildId) || "."}volume/볼륨 [0~1] : 볼륨 설정 (즉시 적용)
> ${prefixes.get(guildId) || "."}remove/삭제/제거 [번호] : 대기열에서 곡 제거
> ${prefixes.get(guildId) || "."}setprefix/prefix [문자] : 서버 prefix 변경
> ${prefixes.get(guildId) || "."}clean/청소 : 봇 메세지 삭제(100개 까지)
> ${prefixes.get(guildId) || "."}help/도움말 : 이 도움말 표시
`;

    return message.reply(text);
  }
  /* ===================== clean ===================== */
  if (["clean", "청소"].includes(command)) {
    const messages = await message.channel.messages.fetch({ limit: 100 });

    // 봇이 보낸 메시지만 필터링 (답장 포함)
    const botMessages = messages.filter(
      (msg) => msg.author.id === client.user.id
    );

    if (botMessages.size === 0) {
      return message.reply("지울 메시지가 없습니다.");
    }

    await message.channel.bulkDelete(botMessages, true);

    const confirm = await message.channel.send(
      `${botMessages.size}개 만큼 청소했습니다.`
    );

    setTimeout(() => {
      confirm.delete().catch(() => {});
    }, 3000);
  }
});

/* ===================== playNext ===================== */
async function playNext(guildId, message) {
  const data = queues.get(guildId);
  if (!data) return;

  // 🔁 repeat ON → current를 항상 큐 뒤로
  if (data.repeat && data.current) {
    data.queue.push(data.current);
  }

  const song = data.queue.shift();

  if (!song) {
    const conn = getVoiceConnection(guildId);
    if (conn) conn.destroy();
    queues.delete(guildId);
    message.channel.send("⏹ 대기열이 모두 재생됨.");
    return;
  }

  data.current = song;

  try {
    const info = await youtubedl(song.url, {
      dumpSingleJson: true,
      noWarnings: true,
      preferFreeFormats: true,
    });

    const audioFormats = info.formats?.filter(
      (f) => f.acodec !== "none" && f.vcodec === "none"
    );

    if (!audioFormats || audioFormats.length === 0) {
      throw new Error("오디오 포맷 없음");
    }

    const best = audioFormats.sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

    const stream = new prism.FFmpeg({
      args: [
        "-reconnect",
        "1",
        "-reconnect_streamed",
        "1",
        "-reconnect_delay_max",
        "5",
        "-i",
        best.url,
        "-analyzeduration",
        "0",
        "-loglevel",
        "0",
        "-f",
        "s16le",
        "-ar",
        "48000",
        "-ac",
        "2",
      ],
    });

    const resource = createAudioResource(stream, {
      inputType: StreamType.Raw,
      inlineVolume: true,
    });

    resource.volume.setVolume(data.volume);
    data.player.play(resource);

    const icon = data.repeat ? "🔁 " : "";
    message.channel.send(`${icon}▶️ **${song.title}**`);
  } catch (err) {
    console.error("❌ Stream error:", err);
    data.current = null;
    playNext(guildId, message);
  }
}

client.login(token);
