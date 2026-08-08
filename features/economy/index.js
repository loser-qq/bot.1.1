try {
  require('dotenv').config();
} catch (_) {
  const fs = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '.env');

  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex === -1) continue;
      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim();
      if (key && process.env[key] == null) {
        process.env[key] = value;
      }
    }
  }
}

process.on('uncaughtException', (err) => {
  process.stdout.write('[FATAL] uncaughtException: ' + err.message + '\n' + err.stack + '\n');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  process.stdout.write('[FATAL] unhandledRejection: ' + String(reason) + '\n');
  process.exit(1);
});

process.stdout.write('[STARTUP] index.js loaded\n');

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  UserSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ButtonStyle,
  PermissionFlagsBits,
  MessageFlags,
  ChannelType,
} = require('discord.js');

const db = require('./database.js');

function requireGachaModule(moduleName) {
  try {
    return require(`./data/${moduleName}`);
  } catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') {
      throw error;
    }
    return require(`./${moduleName}`);
  }
}

const { gachaCommandBuilders, isGachaCommandName, handleGachaCommand } = requireGachaModule('gacha.js');
const { handleGachaButtonInteraction } = requireGachaModule('gachaButtons.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const DEVELOPER_ID = process.env.DEVELOPER_ID;

if (!TOKEN || !CLIENT_ID) {
  process.stdout.write('[STARTUP] DISCORD_TOKEN or CLIENT_ID is missing\n');
}

function getUnit(guildId) {
  const settings = db.getSettings(guildId);
  return settings.currency_unit || 'コイン';
}

function parseNewlines(text) {
  return String(text).replace(/\\/g, '\n');
}

function normalizeVendingPanelKey(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidVendingPanelKey(value) {
  return /^[a-z0-9_-]{1,20}$/.test(value);
}

function hasPermittedRole(member, guildId) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const permittedRoles = db.getPermittedRoles(guildId);
  return permittedRoles.some(roleId => member.roles.cache.has(roleId));
}

function isTextBasedChannel(channel) {
  return channel && typeof channel.isTextBased === 'function' && channel.isTextBased();
}

async function sendToConfiguredChannel(guild, channelId, payload) {
  if (!channelId) return;
  const channel = guild.channels.cache.get(channelId);
  if (!isTextBasedChannel(channel)) return;
  await channel.send(payload);
}

async function getGuildInvite(guild) {
  try {
    const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
    if (!me) return '招待リンクを作成できません';

    const channel = guild.channels.cache.find(ch => {
      if (!isTextBasedChannel(ch)) return false;
      const perms = ch.permissionsFor(me);
      return perms?.has(PermissionFlagsBits.CreateInstantInvite);
    });

    if (!channel) return '招待リンクを作成できません';

    const invite = await channel.createInvite({ maxAge: 0, maxUses: 0, unique: false });
    return `https://discord.gg/${invite.code}`;
  } catch (_) {
    return '招待リンクを作成できません';
  }
}

function buildCommandListEmbed() {
  return new EmbedBuilder()
    .setTitle('📋 コマンド一覧')
    .setColor(0x5865f2)
    .setDescription('コマンド一覧を表示します。')
    .addFields(
      {
        name: '通貨',
        value: [
          '`/送金 @ユーザー 金額` ユーザー間送金',
          '`/付与 @ユーザー 金額` 管理者または許可ロールによる付与',
          '`/減額 @ユーザー 金額` 管理者または許可ロールによる減額',
          '`/通貨単位設定 単位` 通貨単位の変更',
          '`/送金ログチャンネル #チャンネル` 送金ログ送信先の設定',
          '`/付与ログチャンネル #チャンネル` 付与ログ送信先の設定',
          '`/減額ログチャンネル #チャンネル` 減額ログ送信先の設定',
        ].join('\n'),
      },
      {
        name: '自販機',
        value: [
          '`/自販機パネル設置 パネルID #チャンネル タイトル 説明` 購入ボタン付き自販機パネルを設置',
          '`/自販機商品設定 設定 パネルID スロット 商品名 ロール 値段 時間(分)` 商品を設定/更新',
          '`/自販機商品設定 削除 パネルID スロット` 商品を削除',
          '`/自販機商品設定 一覧 パネルID [表示]` 商品一覧を表示',
          '`/自販機ログチャンネル パネルID #チャンネル` 購入ログ送信先を設定',
          '`/vc自販機パネル設置 パネルID #チャンネル タイトル 説明` VC公開/非公開の購入パネルを設置',
          '`/vc自販機パネル削除 パネルID` VC自販機パネルを削除',
          '`/vc自販機商品設定 設定 パネルID スロット 商品名 対象VC 公開設定 値段 時間(分)` 商品を設定/更新',
          '`/vc自販機商品設定 削除 パネルID スロット` 商品を削除',
          '`/vc自販機商品設定 一覧 パネルID [表示]` 商品一覧を表示',
          '`/vc自販機ログチャンネル パネルID #チャンネル` 購入ログ送信先を設定',
        ].join('\n'),
      },
      {
        name: '面接通過ワークフロー',
        value: [
          '`/面接通過許可ロール @ロール` /面接通過 の実行権限ロールを設定',
          '`/面接設定 @外すロール @付与するロール 付与金額` 面接処理内容を設定',
          '`/面接通過` VC参加者に一括処理を実行',
          '`/面接通過ログチャンネル #チャンネル` 面接通過ログ送信先の設定',
        ].join('\n'),
      },
      {
        name: '評価関連',
        value: [
          '`/評価期限設定 日数 対象ロール` 評価期限日数と評価期限を表示する対象ロールを設定',
          '`/ロール表示除外設定 [表示ロール1] [表示ロール2] [表示ロール3]` 対象外メンバーに表示するロールを最大3つ設定（未指定で解除）',
          '`/評価リセット [ユーザー]` 開発者向けに評価情報をリセット（未指定で全員）',
          '`/評価一覧 [表示]` 開発者向けに評価情報の一覧を表示',
        ].join('\n'),
      },
      {
        name: 'VCレベリング',
        value: [
          '`/レベリングログチャンネル #チャンネル` レベルアップログ送信先の設定',
          '`/レベリング設定 時間設定` レベルごとの必要VC参加時間を設定',
          '`/レベリング設定 時間一括設定` 10レベル分まとめて必要VC参加時間を設定',
          '`/レベリング設定 ロール設定` レベル範囲に対応するロールを設定',
          '`/自分 [表示]` 自分の残高とVCレベルを確認',
          '`/ユーザー情報 ユーザー [表示]` 開発者向けに指定ユーザーの情報を確認',
          '`/vc接続時間ランキング [表示]` VC接続時間TOP10を表示',
        ].join('\n'),
      },
      {
        name: 'ガチャ',
        value: [
          '`/ガチャ作成` 箱ガチャを作成・価格設定',
          '`/商品追加` 商品名・数量・レアリティを登録',
          '`/商品削除` 商品を削除',
          '`/商品一覧` 商品一覧を表示',
          '`/ガチャ設置` 4ボタン付きガチャパネルを設置',
          '`/ガチャ情報` ガチャ設定を表示',
          '`/提供割合` 残数から割合を表示',
          '`/ガチャログ` 抽選ログ送信先を設定',
          '`/次の商品` 次回抽選の商品を固定',
          '`/ガチャリセット` 在庫を初期値に戻す',
        ].join('\n'),
      },
      {
        name: '管理・開発者向け',
        value: [
          '`/vc接続時間リセット ユーザー` 開発者向けに指定ユーザーのVC接続時間をリセット',
          '`/vc接続時間全リセット` 開発者向けに全ユーザーのVC接続時間をリセット',
          '`/残高全額リセット ユーザー` 開発者向けに指定ユーザーの残高を0にリセット',
          '`/残高全額全リセット` 開発者向けに全ユーザーの残高を0にリセット',
          '`/給与設定 ロール 金額` ロールごとの給与を設定',
          '`/給与設定解除 ロール` ロール給与設定を解除',
          '`/給与設定一覧` ロール給与設定の一覧を表示',
          '`/給与一括付与 ロール` 指定ロールへ給与を一括付与',
          '`/給与全ロール一括付与` 設定済みロールすべてに一括付与',
          '`/コマンド一覧` コマンド一覧を表示',
          '`/設定状況` サーバー設定状況を表示',
          '`/bot情報` 参加サーバー一覧と招待リンクを表示',
        ].join('\n'),
      },
      {
        name: '表示設定',
        value: '一部の情報系コマンドは「公開 / 非公開」を選べます。',
      },
    )
    .setTimestamp();
}

function buildStatusEmbed(guild) {
  const settings = db.getSettings(guild.id);
  const unit = settings.currency_unit || 'コイン';
  const permittedRoles = db.getPermittedRoles(guild.id);
  const transferLogChannelId = settings.transfer_log_channel_id || settings.log_channel_id;
  const vendingPanels = db.getVendingPanels(guild.id);
  const totalVendingProducts = vendingPanels.reduce((sum, p) => sum + db.getVendingProducts(guild.id, p.panel_key).length, 0);
  const vendingLogCount = vendingPanels.filter(p => !!p.log_channel_id).length;
  const vcVendingPanels = db.getVcVendingPanels(guild.id);
  const totalVcVendingProducts = vcVendingPanels.reduce((sum, p) => sum + db.getVcVendingProducts(guild.id, p.panel_key).length, 0);
  const vcVendingLogCount = vcVendingPanels.filter(p => !!p.log_channel_id).length;

  return new EmbedBuilder()
    .setTitle('⚙️ サーバー設定状況')
    .setColor(0x5865f2)
    .setDescription(`サーバー: **${guild.name}**`)
    .addFields(
      { name: '通貨単位', value: unit, inline: true },
      { name: '送金ログ', value: transferLogChannelId ? `<#${transferLogChannelId}>` : '未設定', inline: true },
      { name: '付与ログ', value: settings.grant_log_channel_id ? `<#${settings.grant_log_channel_id}>` : '未設定', inline: true },
      { name: '減額ログ', value: settings.deduction_log_channel_id ? `<#${settings.deduction_log_channel_id}>` : '未設定', inline: true },
      { name: '面接通過ログ', value: settings.interview_log_channel_id ? `<#${settings.interview_log_channel_id}>` : '未設定', inline: true },
      { name: 'レベリングログ', value: settings.leveling_log_channel_id ? `<#${settings.leveling_log_channel_id}>` : '未設定', inline: true },
      { name: 'レベリング時間', value: getLevelingRangeSummary(guild.id), inline: false },
      { name: 'レベリングロール', value: getLevelingRoleSummary(guild.id), inline: false },
      { name: '面接許可ロール', value: permittedRoles.length > 0 ? permittedRoles.map(id => `<@&${id}>`).join('\n') : '未設定', inline: false },
      { name: '外すロール', value: settings.remove_role_id ? `<@&${settings.remove_role_id}>` : '未設定', inline: true },
      { name: '付与するロール', value: settings.add_role_id ? `<@&${settings.add_role_id}>` : '未設定', inline: true },
      { name: '付与金額', value: settings.grant_amount != null ? `${Number(settings.grant_amount).toLocaleString()} ${unit}` : '未設定', inline: true },
      { name: '評価期限日数', value: settings.evaluation_days != null ? `${Math.max(0, Number(settings.evaluation_days))}日` : '未設定', inline: true },
      { name: '評価期限対象ロール', value: settings.evaluation_role_id ? `<@&${settings.evaluation_role_id}>` : '未設定', inline: true },
      {
        name: '対象外メンバー表示ロール',
        value: [settings.role_display_include1_id, settings.role_display_include2_id, settings.role_display_include3_id]
          .filter(Boolean)
          .map(id => `<@&${id}>`)
          .join('\n') || '未設定',
        inline: true,
      },
      { name: '自販機パネル数', value: `${vendingPanels.length}件`, inline: true },
      { name: '自販機商品数', value: `${totalVendingProducts}件`, inline: true },
      { name: '自販機ログ設定', value: `${vendingLogCount}件`, inline: true },
      { name: 'VC自販機パネル数', value: `${vcVendingPanels.length}件`, inline: true },
      { name: 'VC自販機商品数', value: `${totalVcVendingProducts}件`, inline: true },
      { name: 'VC自販機ログ設定', value: `${vcVendingLogCount}件`, inline: true },
    )
    .setTimestamp();
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function buildBotInfoEmbeds() {
  const guilds = [...client.guilds.cache.values()];
  const embeds = [
    new EmbedBuilder()
      .setTitle('🤖 BOT参加サーバー一覧')
      .setColor(0x5865f2)
      .setDescription(`合計 **${guilds.length}** サーバーに参加中`)
      .setTimestamp(),
  ];

  for (const group of chunkArray(guilds, 20)) {
    const embed = new EmbedBuilder().setColor(0x5865f2);
    for (const guild of group) {
      const invite = await getGuildInvite(guild);
      embed.addFields({
        name: guild.name,
        value: [
          `ID: ${guild.id}`,
          `招待: ${invite}`,
        ].join('\n'),
      });
    }
    embeds.push(embed);
  }

  return embeds;
}

const DEFAULT_LEVEL_UP_SECONDS = 60 * 60;

function formatDuration(seconds) {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  const parts = [];
  if (hours > 0) parts.push(`${hours}時間`);
  if (minutes > 0) parts.push(`${minutes}分`);
  if (hours === 0 && minutes === 0) parts.push(`${remainingSeconds}秒`);
  return parts.join('') || '0秒';
}

function formatDateTime(timestamp) {
  return new Date(timestamp).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

function getNextDayStartAtJst(timestamp) {
  const dayMs = 24 * 60 * 60 * 1000;
  const jstOffsetMs = 9 * 60 * 60 * 1000;
  const jstTimestamp = timestamp + jstOffsetMs;
  const jstDayStart = Math.floor(jstTimestamp / dayMs) * dayMs;
  return (jstDayStart + dayMs) - jstOffsetMs;
}

function getLevelUpSeconds(guildId, level) {
  const row = db.getLevelingThreshold(guildId, level);
  return row ? row.required_seconds : DEFAULT_LEVEL_UP_SECONDS;
}

function calculateLevelingState(guildId, totalSeconds) {
  let level = 1;
  let remaining = Math.max(0, Math.floor(totalSeconds));

  while (true) {
    const requiredSeconds = getLevelUpSeconds(guildId, level);
    if (remaining < requiredSeconds) {
      return {
        level,
        progressSeconds: remaining,
        requiredSeconds,
        remainingToNext: requiredSeconds - remaining,
      };
    }

    remaining -= requiredSeconds;
    level += 1;

    if (level >= 9999) {
      return {
        level,
        progressSeconds: remaining,
        requiredSeconds: getLevelUpSeconds(guildId, level),
        remainingToNext: 0,
      };
    }
  }
}

function getEffectiveLevelingSeconds(userId, guildId, now = Date.now()) {
  const profile = db.getLevelingProfile(userId, guildId);
  const session = db.getActiveLevelingSession(userId, guildId);
  const sessionSeconds = session ? Math.max(0, Math.floor((now - session.joined_at) / 1000)) : 0;
  return profile.total_seconds + sessionSeconds;
}

function getLevelingRangeSummary(guildId) {
  const thresholds = db.getLevelingThresholds(guildId);
  if (thresholds.length === 0) {
    return `未設定（既定: ${formatDuration(DEFAULT_LEVEL_UP_SECONDS)}）`;
  }

  const lines = thresholds.slice(0, 10).map(row => `Lv${row.level} → Lv${row.level + 1}: ${formatDuration(row.required_seconds)}`);
  if (thresholds.length > 10) {
    lines.push(`...他 ${thresholds.length - 10} 件`);
  }
  return lines.join('\n');
}

function getLevelingRoleSummary(guildId) {
  const ranges = db.getLevelingRoleRanges(guildId);
  if (ranges.length === 0) {
    return '未設定';
  }

  const lines = ranges.slice(0, 10).map(row => `Lv${row.start_level} - Lv${row.end_level}: <@&${row.role_id}>`);
  if (ranges.length > 10) {
    lines.push(`...他 ${ranges.length - 10} 件`);
  }
  return lines.join('\n');
}

function buildLevelingSettingsEmbed(guild) {
  return new EmbedBuilder()
    .setTitle('📈 VCレベリング設定')
    .setColor(0x57f287)
    .addFields(
      { name: 'レベルアップ時間', value: getLevelingRangeSummary(guild.id), inline: false },
      { name: '対応ロール', value: getLevelingRoleSummary(guild.id), inline: false },
      { name: '現在の基準', value: `未設定のレベルは **${formatDuration(DEFAULT_LEVEL_UP_SECONDS)}** で1つ上がります。`, inline: false },
    )
    .setTimestamp();
}

function buildVcConnectionRankingEmbed(guild) {
  const rows = db.getLevelingProfiles(guild.id);
  const unit = getUnit(guild.id);
  const topRows = rows.slice(0, 10);
  const description = topRows.length > 0
    ? topRows.map((row, index) => `${index + 1}. <@${row.user_id}>: ${formatDuration(row.total_seconds)} (${row.last_level}Lv)`).join('\n')
    : 'まだ記録がありません。';

  return new EmbedBuilder()
    .setTitle('🏆 VC接続時間ランキング')
    .setColor(0x5865f2)
    .setDescription(description)
    .setFooter({ text: `表示単位: ${unit}` })
    .setTimestamp();
}

function buildLevelingProfileEmbed(targetMember, guild) {
  const now = Date.now();
  const totalSeconds = getEffectiveLevelingSeconds(targetMember.id, guild.id, now);
  const state = calculateLevelingState(guild.id, totalSeconds);
  const range = db.getLevelingRoleRangeForLevel(guild.id, state.level);
  const session = db.getActiveLevelingSession(targetMember.id, guild.id);

  return new EmbedBuilder()
    .setTitle('📈 VCレベリング確認')
    .setColor(0x5865f2)
    .setDescription(`対象: <@${targetMember.id}>`)
    .addFields(
      { name: '現在レベル', value: `Lv${state.level}`, inline: true },
      { name: 'VC参加時間', value: formatDuration(totalSeconds), inline: true },
      { name: '次のレベルまで', value: state.remainingToNext > 0 ? formatDuration(state.remainingToNext) : '到達済み', inline: true },
      { name: '対応ロール', value: range ? `<@&${range.role_id}>` : '未設定', inline: true },
      { name: 'VC参加中', value: session ? 'はい' : 'いいえ', inline: true },
      { name: '次の目標', value: `Lv${state.level + 1}`, inline: true },
    )
    .setFooter({ text: 'レベルはVC参加時間の累積で計算されます。' })
    .setTimestamp();
}

function buildLevelingInfoEmbed(targetMember, guild) {
  const now = Date.now();
  const totalSeconds = getEffectiveLevelingSeconds(targetMember.id, guild.id, now);
  const state = calculateLevelingState(guild.id, totalSeconds);
  const range = db.getLevelingRoleRangeForLevel(guild.id, state.level);
  const session = db.getActiveLevelingSession(targetMember.id, guild.id);
  const balance = db.getBalance(targetMember.id, guild.id);
  const unit = getUnit(guild.id);
  const settings = db.getSettings(guild.id);
  const evaluationDays = Math.max(0, Math.floor(Number(settings.evaluation_days || 0)));
  const evaluationRoleId = settings.evaluation_role_id || null;
  const displayIncludeRoleIds = [
    settings.role_display_include1_id,
    settings.role_display_include2_id,
    settings.role_display_include3_id,
  ].filter(Boolean);
  const roleDisplayExcludeId = settings.role_display_exclude_id || evaluationRoleId;
  const hasEvaluationRole = !!evaluationRoleId && targetMember.roles.cache.has(evaluationRoleId);

  const extraFields = [];
  if (hasEvaluationRole) {
    if (evaluationDays <= 0) {
      extraFields.push({ name: '評価期限', value: '未設定（管理者が `/評価期限設定` を実行してください）', inline: false });
    } else {
      const evaluation = db.getInterviewEvaluation(targetMember.id, guild.id);
      if (!evaluation) {
        extraFields.push({ name: '評価期限', value: '面接通過日時が未記録です。', inline: false });
      } else {
        const periodStartAt = getNextDayStartAtJst(evaluation.passed_at);
        const deadlineAt = periodStartAt + (evaluationDays * 24 * 60 * 60 * 1000);
        const remainingMs = deadlineAt - now;
        const remainingText = remainingMs > 0 ? `あと **${formatDuration(Math.floor(remainingMs / 1000))}**` : '期限切れ';
        extraFields.push({
          name: '評価期限',
          value: [
            remainingText,
            `評価開始: ${formatDateTime(periodStartAt)}`,
            `期限日時: ${formatDateTime(deadlineAt)}`,
            `通過日時: ${formatDateTime(evaluation.passed_at)}`,
          ].join('\n'),
          inline: false,
        });
      }
    }
  } else {
    const roleMentions = displayIncludeRoleIds.length > 0
      ? displayIncludeRoleIds.filter(roleId => targetMember.roles.cache.has(roleId)).map(roleId => `<@&${roleId}>`)
      : targetMember.roles.cache
        .filter(role => role.id !== guild.id && role.id !== roleDisplayExcludeId)
        .map(role => `<@&${role.id}>`);
    extraFields.push({ name: 'ロール', value: roleMentions.length > 0 ? roleMentions.join(' ') : 'なし', inline: false });
  }

  return new EmbedBuilder()
    .setTitle('📌 ユーザー情報')
    .setColor(0x5865f2)
    .setDescription(`対象: <@${targetMember.id}>`)
    .addFields(
      { name: '残高', value: `${balance.toLocaleString()} ${unit}`, inline: true },
      { name: '現在レベル', value: `Lv${state.level}`, inline: true },
      { name: '次のレベルまで', value: state.remainingToNext > 0 ? formatDuration(state.remainingToNext) : '到達済み', inline: true },
      { name: 'VC参加時間', value: formatDuration(totalSeconds), inline: true },
      { name: '対応ロール', value: range ? `<@&${range.role_id}>` : '未設定', inline: true },
      { name: 'VC参加中', value: session ? 'はい' : 'いいえ', inline: true },
      ...extraFields,
    )
    .setTimestamp();
}

function buildLevelUpLogEmbed({ targetMember, guild, previousLevel, currentLevel, totalSeconds }) {
  const range = db.getLevelingRoleRangeForLevel(guild.id, currentLevel);
  const state = calculateLevelingState(guild.id, totalSeconds);

  return new EmbedBuilder()
    .setTitle('📈 レベルアップログ')
    .setColor(0x57f287)
    .addFields(
      { name: '対象ユーザー', value: `<@${targetMember.id}>`, inline: true },
      { name: 'レベル', value: `Lv${previousLevel} → Lv${currentLevel}`, inline: true },
      { name: 'VC参加時間', value: formatDuration(totalSeconds), inline: true },
      { name: '対応ロール', value: range ? `<@&${range.role_id}>` : '未設定', inline: true },
      { name: '次のレベルまで', value: state.remainingToNext > 0 ? formatDuration(state.remainingToNext) : '到達済み', inline: true },
    )
    .setTimestamp();
}

function buildRoleSalarySettingsEmbed(guild) {
  const settings = db.getRoleSalarySettings(guild.id);
  const unit = getUnit(guild.id);
  const value = settings.length > 0
    ? settings.map(row => `<@&${row.role_id}>: ${row.amount.toLocaleString()} ${unit}`).join('\n')
    : '未設定';

  return new EmbedBuilder()
    .setTitle('💼 ロール給与設定一覧')
    .setColor(0xfee75c)
    .addFields({ name: '設定', value })
    .setTimestamp();
}

function buildEvaluationListEmbeds(guild, rows) {
  const settings = db.getSettings(guild.id);
  const evaluationDays = Math.max(0, Math.floor(Number(settings.evaluation_days || 0)));
  const now = Date.now();

  if (rows.length === 0) {
    return [
      new EmbedBuilder()
        .setTitle('📋 評価一覧')
        .setColor(0x5865f2)
        .setDescription('評価データはありません。')
        .setTimestamp(),
    ];
  }

  const lines = rows.map(row => {
    if (evaluationDays <= 0) {
      return `<@${row.user_id}> | 通過: ${formatDateTime(row.passed_at)} | 期限日数未設定`;
    }

    const periodStartAt = getNextDayStartAtJst(row.passed_at);
    const deadlineAt = periodStartAt + (evaluationDays * 24 * 60 * 60 * 1000);
    const remainingMs = deadlineAt - now;
    const status = remainingMs > 0 ? `評価中（残り ${formatDuration(Math.floor(remainingMs / 1000))}）` : '期限切れ';

    return [
      `<@${row.user_id}> | ${status}`,
      `通過: ${formatDateTime(row.passed_at)} / 評価開始: ${formatDateTime(periodStartAt)} / 期限: ${formatDateTime(deadlineAt)}`,
    ].join('\n');
  });

  const chunks = chunkArray(lines, 10);
  return chunks.map((chunk, index) => (
    new EmbedBuilder()
      .setTitle(`📋 評価一覧 (${index + 1}/${chunks.length})`)
      .setColor(0x5865f2)
      .setDescription(chunk.join('\n\n'))
      .setTimestamp()
  ));
}

function buildVendingProductsText(guildId, panelKey) {
  const products = db.getVendingProducts(guildId, panelKey);
  const unit = getUnit(guildId);
  if (products.length === 0) {
    return '商品は未設定です。';
  }

  return products.map(p => [
    `**${p.slot}. ${p.label}**`,
    `ロール: <@&${p.role_id}>`,
    `値段: ${p.price.toLocaleString()} ${unit}`,
    `時間: ${p.duration_minutes}分`,
  ].join(' / ')).join('\n');
}

function buildVendingPanelEmbed(guild, panel) {
  return new EmbedBuilder()
    .setTitle(panel.title)
    .setColor(0x2b2d31)
    .setDescription(`${panel.description}\n\n${buildVendingProductsText(guild.id, panel.panel_key)}`)
    .setFooter({ text: 'ボタンを押すと購入します。' })
    .setTimestamp();
}

function buildVendingPanelComponents(guildId, panelKey) {
  const products = db.getVendingProducts(guildId, panelKey);
  if (products.length === 0) {
    return [];
  }

  const buttons = products
    .sort((a, b) => a.slot - b.slot)
    .map(product => (
      new ButtonBuilder()
        .setCustomId(`vending_buy:${panelKey}:${product.slot}`)
        .setLabel(`${product.slot}: ${product.label}`.slice(0, 80))
        .setStyle(ButtonStyle.Secondary)
    ));

  return [
    new ActionRowBuilder().addComponents(buttons.slice(0, 5)),
  ];
}

function buildVendingProductListEmbed(guild, panelKey) {
  const panel = db.getVendingPanel(guild.id, panelKey);
  return new EmbedBuilder()
    .setTitle(`🛒 自販機商品一覧 (${panelKey})`)
    .setColor(0x5865f2)
    .addFields(
      { name: '商品一覧', value: buildVendingProductsText(guild.id, panelKey), inline: false },
      { name: 'パネル', value: panel && panel.channel_id && panel.message_id ? `<#${panel.channel_id}> / ${panel.message_id}` : '未設置', inline: false },
      { name: '購入ログ', value: db.getVendingLogChannel(guild.id, panelKey) ? `<#${db.getVendingLogChannel(guild.id, panelKey)}>` : '未設定', inline: false },
    )
    .setTimestamp();
}

async function refreshVendingPanel(guild, panelKey) {
  const panel = db.getVendingPanel(guild.id, panelKey);
  if (!panel || !panel.channel_id || !panel.message_id) return;

  const channel = guild.channels.cache.get(panel.channel_id);
  if (!isTextBasedChannel(channel)) return;

  const message = await channel.messages.fetch(panel.message_id).catch(() => null);
  if (!message) return;

  await message.edit({
    embeds: [buildVendingPanelEmbed(guild, panel)],
    components: buildVendingPanelComponents(guild.id, panel.panel_key),
  });
}

function buildVendingPurchaseLogEmbed({ buyerId, roleId, label, price, durationMinutes, expiresAt, unit }) {
  return new EmbedBuilder()
    .setTitle('🧾 自販機購入ログ')
    .setColor(0x57f287)
    .addFields(
      { name: '購入者', value: `<@${buyerId}>`, inline: true },
      { name: '商品', value: label, inline: true },
      { name: 'ロール', value: `<@&${roleId}>`, inline: true },
      { name: '価格', value: `${price.toLocaleString()} ${unit}`, inline: true },
      { name: '有効時間', value: `${durationMinutes}分`, inline: true },
      { name: '期限', value: formatDateTime(expiresAt), inline: true },
    )
    .setTimestamp();
}

function getVcVisibilityLabel(mode) {
  return mode === 'public' ? '公開' : '非公開';
}

function buildPrivateVcAccessPanelEmbed(ownerId, expiresAt) {
  return new EmbedBuilder()
    .setTitle('🔒 シークレットvcアクセス権限')
    .setColor(0x3ba55d)
    .setDescription([
      `オーナー: <@${ownerId}>`,
      'このVCに参加させたいユーザーを追加できます。',
      `期限: ${formatDateTime(expiresAt)}`,
    ].join('\n'))
    .setTimestamp();
}

function buildPrivateVcAccessPanelComponents(voiceChannelId, ownerId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`vc_room_add:${voiceChannelId}:${ownerId}`)
        .setLabel('メンバー追加')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`vc_room_remove:${voiceChannelId}:${ownerId}`)
        .setLabel('メンバー削除')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`vc_room_rename:${voiceChannelId}:${ownerId}`)
        .setLabel('部屋名変更')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function buildPrivateVcUserSelectComponents(voiceChannelId, ownerId) {
  return [
    new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId(`vc_room_add_select:${voiceChannelId}:${ownerId}`)
        .setPlaceholder('VCに追加するユーザーを選択')
        .setMinValues(1)
        .setMaxValues(5),
    ),
  ];
}

function buildPrivateVcRemoveUserSelectComponents(voiceChannelId, ownerId) {
  return [
    new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId(`vc_room_remove_select:${voiceChannelId}:${ownerId}`)
        .setPlaceholder('VCから削除するユーザーを選択')
        .setMinValues(1)
        .setMaxValues(5),
    ),
  ];
}

async function applyVoiceChannelVisibility(channel, mode) {
  if (!channel || channel.type !== ChannelType.GuildVoice) {
    throw new Error('vc_channel_invalid');
  }

  const everyoneRole = channel.guild.roles.everyone;
  const isPublic = mode === 'public';
  await channel.permissionOverwrites.edit(everyoneRole, {
    ViewChannel: isPublic,
    Connect: isPublic,
  });
}

function buildPrivateRoomPermissionOverwrites(guild, ownerId) {
  return [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.SendMessages],
    },
    {
      id: ownerId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
        PermissionFlagsBits.Stream,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
  ];
}

async function sendPrivateRoomNotice(guild, voiceChannelId, content, embeds = [], components = []) {
  const purchase = db.getVcVendingPurchase(guild.id, voiceChannelId);
  if (!purchase || !purchase.text_channel_id) return;
  const textChannel = guild.channels.cache.get(purchase.text_channel_id);
  if (!isTextBasedChannel(textChannel)) return;
  await textChannel.send({ content, embeds, components }).catch(() => null);
}

async function createPrivateRoomFromTemplate(guild, ownerMember, templateVoiceChannel, label, expiresAt) {
  const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
  const vcName = `${ownerMember.displayName}様`.slice(0, 90);
  const chatName = `${ownerMember.displayName}様-chat`.slice(0, 100);
  const overwrites = buildPrivateRoomPermissionOverwrites(guild, ownerMember.id);

  if (me) {
    overwrites.push({
      id: me.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
      ],
    });
  }

  const privateChannel = await guild.channels.create({
    name: vcName,
    type: ChannelType.GuildVoice,
    parent: templateVoiceChannel.parentId || null,
    permissionOverwrites: overwrites,
    reason: `VC自販機購入: ${label} (${ownerMember.id})`,
  });

  let privateTextChannel;
  try {
    privateTextChannel = await guild.channels.create({
      name: chatName,
      type: ChannelType.GuildText,
      parent: templateVoiceChannel.parentId || null,
      permissionOverwrites: overwrites,
      reason: `VC自販機購入チャット: ${label} (${ownerMember.id})`,
    });
  } catch (error) {
    await privateChannel.delete('VC自販機チャット作成失敗のため削除').catch(() => null);
    throw error;
  }

  await privateTextChannel.send({
    embeds: [buildPrivateVcAccessPanelEmbed(ownerMember.id, expiresAt)],
    components: buildPrivateVcAccessPanelComponents(privateChannel.id, ownerMember.id),
  }).catch(() => null);

  return { voiceChannel: privateChannel, textChannel: privateTextChannel };
}

function buildVcVendingProductsText(guild, panelKey) {
  const products = db.getVcVendingProducts(guild.id, panelKey);
  const unit = getUnit(guild.id);
  if (products.length === 0) {
    return '商品は未設定です。';
  }

  return products.map(p => [
    `**${p.slot}. ${p.label}**`,
    `対象VC: <#${p.voice_channel_id}>`,
    `設定: ${getVcVisibilityLabel(p.visibility_mode)}`,
    `値段: ${p.price.toLocaleString()} ${unit}`,
    `時間: ${p.duration_minutes}分`,
  ].join(' / ')).join('\n');
}

function buildVcVendingPanelEmbed(guild, panel) {
  return new EmbedBuilder()
    .setTitle(panel.title)
    .setColor(0x3ba55d)
    .setDescription(`${panel.description}\n\n${buildVcVendingProductsText(guild, panel.panel_key)}`)
    .setFooter({ text: 'ボタンを押すと購入します。' })
    .setTimestamp();
}

function buildVcVendingPanelComponents(guildId, panelKey) {
  const products = db.getVcVendingProducts(guildId, panelKey);
  if (products.length === 0) {
    return [];
  }

  const buttons = products
    .sort((a, b) => a.slot - b.slot)
    .map(product => (
      new ButtonBuilder()
        .setCustomId(`vc_vending_buy:${panelKey}:${product.slot}`)
        .setLabel(`${product.slot}: ${product.label}`.slice(0, 80))
        .setStyle(ButtonStyle.Success)
    ));

  return [
    new ActionRowBuilder().addComponents(buttons.slice(0, 5)),
  ];
}

function buildVcVendingProductListEmbed(guild, panelKey) {
  const panel = db.getVcVendingPanel(guild.id, panelKey);
  return new EmbedBuilder()
    .setTitle(`🎛️ VC自販機商品一覧 (${panelKey})`)
    .setColor(0x3ba55d)
    .addFields(
      { name: '商品一覧', value: buildVcVendingProductsText(guild, panelKey), inline: false },
      { name: 'パネル', value: panel && panel.channel_id && panel.message_id ? `<#${panel.channel_id}> / ${panel.message_id}` : '未設置', inline: false },
      { name: '購入ログ', value: db.getVcVendingLogChannel(guild.id, panelKey) ? `<#${db.getVcVendingLogChannel(guild.id, panelKey)}>` : '未設定', inline: false },
    )
    .setTimestamp();
}

async function refreshVcVendingPanel(guild, panelKey) {
  const panel = db.getVcVendingPanel(guild.id, panelKey);
  if (!panel || !panel.channel_id || !panel.message_id) return;

  const channel = guild.channels.cache.get(panel.channel_id);
  if (!isTextBasedChannel(channel)) return;

  const message = await channel.messages.fetch(panel.message_id).catch(() => null);
  if (!message) return;

  await message.edit({
    embeds: [buildVcVendingPanelEmbed(guild, panel)],
    components: buildVcVendingPanelComponents(guild.id, panel.panel_key),
  });
}

function buildVcVendingPurchaseLogEmbed({ buyerId, label, voiceChannelId, visibilityMode, price, durationMinutes, expiresAt, unit }) {
  return new EmbedBuilder()
    .setTitle('🧾 VC自販機購入ログ')
    .setColor(0x3ba55d)
    .addFields(
      { name: '購入者', value: `<@${buyerId}>`, inline: true },
      { name: '商品', value: label, inline: true },
      { name: '対象VC', value: `<#${voiceChannelId}>`, inline: true },
      { name: '設定', value: getVcVisibilityLabel(visibilityMode), inline: true },
      { name: '価格', value: `${price.toLocaleString()} ${unit}`, inline: true },
      { name: '有効時間', value: `${durationMinutes}分`, inline: true },
      { name: '期限', value: formatDateTime(expiresAt), inline: true },
    )
    .setTimestamp();
}

async function processVendingExpirations() {
  const now = Date.now();
  const expired = db.getExpiredVendingPurchases(now);

  for (const row of expired) {
    try {
      const guild = client.guilds.cache.get(row.guild_id);
      if (guild) {
        const member = guild.members.cache.get(row.user_id) || await guild.members.fetch(row.user_id).catch(() => null);
        if (member && member.roles.cache.has(row.role_id)) {
          await member.roles.remove(row.role_id).catch(() => null);
        }
      }
    } finally {
      db.deleteVendingPurchase(row.guild_id, row.user_id, row.role_id);
    }
  }
}

async function processVcVendingExpirations() {
  const expired = db.getExpiredVcVendingPurchases(Date.now());

  for (const row of expired) {
    try {
      const guild = client.guilds.cache.get(row.guild_id);
      if (!guild) continue;

      const channel = guild.channels.cache.get(row.voice_channel_id);
      if (!channel || channel.type !== ChannelType.GuildVoice) continue;

      if (row.is_temporary) {
        const textChannel = row.text_channel_id ? guild.channels.cache.get(row.text_channel_id) : null;
        await textChannel?.delete('VC自販機の期限切れにより自動削除').catch(() => null);
        await channel.delete('VC自販機の期限切れにより自動削除').catch(() => null);
      } else {
        const revertMode = row.mode === 'public' ? 'private' : 'public';
        await applyVoiceChannelVisibility(channel, revertMode).catch(() => null);
      }
    } finally {
      db.deleteVcVendingPurchase(row.guild_id, row.voice_channel_id);
    }
  }
}

async function grantRoleSalary(guild, roleId, amount) {
  const role = guild.roles.cache.get(roleId);
  if (!role) {
    return { success: false, reason: 'role_not_found', paidCount: 0, totalGranted: 0 };
  }

  const targets = role.members.filter(member => !member.user.bot);
  let paidCount = 0;
  let totalGranted = 0;

  for (const [, target] of targets) {
    db.addBalance(target.id, guild.id, amount);
    paidCount++;
    totalGranted += amount;
  }

  return {
    success: true,
    role,
    paidCount,
    totalGranted,
  };
}

async function sendLevelingLog(guild, payload) {
  const settings = db.getSettings(guild.id);
  if (!settings.leveling_log_channel_id) return;
  await sendToConfiguredChannel(guild, settings.leveling_log_channel_id, payload);
}

async function syncMemberLevelingRoles(member, now = Date.now()) {
  if (!member || member.user.bot) return;

  const guildId = member.guild.id;
  const profile = db.getLevelingProfile(member.id, guildId);
  const totalSeconds = getEffectiveLevelingSeconds(member.id, guildId, now);
  const state = calculateLevelingState(guildId, totalSeconds);
  const targetRange = db.getLevelingRoleRangeForLevel(guildId, state.level);
  const levelingRoleIds = [...new Set(db.getLevelingRoleRanges(guildId).map(row => row.role_id))];

  const currentRoleIds = levelingRoleIds.filter(roleId => member.roles.cache.has(roleId));
  const targetRoleId = targetRange ? targetRange.role_id : null;
  const rolesToRemove = targetRange ? currentRoleIds.filter(roleId => roleId !== targetRoleId) : currentRoleIds;
  const needsAdd = !!targetRoleId && !member.roles.cache.has(targetRoleId);

  try {
    if (rolesToRemove.length > 0) {
      await member.roles.remove(rolesToRemove);
    }
    if (needsAdd) {
      await member.roles.add(targetRoleId);
    }

    if (state.level > profile.last_level) {
      await sendLevelingLog(member.guild, {
        embeds: [buildLevelUpLogEmbed({
          targetMember: member,
          guild: member.guild,
          previousLevel: profile.last_level,
          currentLevel: state.level,
          totalSeconds,
        })],
      });
    }

    if (state.level !== profile.last_level) {
      db.setLevelingLastLevel(member.id, guildId, state.level);
    }
  } catch (error) {
    console.error(`レベリングロール同期エラー (${member.id}):`, error);
  }
}

async function processActiveLevelingSessions() {
  const now = Date.now();
  for (const guild of client.guilds.cache.values()) {
    for (const state of guild.voiceStates.cache.values()) {
      if (!state.channelId || state.member?.user?.bot) continue;
      const member = state.member || await guild.members.fetch(state.id).catch(() => null);
      if (member) {
        await syncMemberLevelingRoles(member, now);
      }
    }
  }
}

async function reconcileLevelingSessions() {
  const now = Date.now();

  for (const guild of client.guilds.cache.values()) {
    const activeSessions = db.getActiveLevelingSessions(guild.id);
    const sessionMap = new Map(activeSessions.map(session => [session.user_id, session]));

    for (const state of guild.voiceStates.cache.values()) {
      if (!state.channelId || state.member?.user?.bot) continue;

      const existingSession = sessionMap.get(state.id);
      if (existingSession) {
        if (existingSession.channel_id !== state.channelId) {
          db.updateLevelingSessionChannel(state.id, guild.id, state.channelId);
        }
      } else {
        db.upsertLevelingSession(state.id, guild.id, state.channelId, now);
      }

      const member = state.member || await guild.members.fetch(state.id).catch(() => null);
      if (member) {
        await syncMemberLevelingRoles(member, now);
      }

      sessionMap.delete(state.id);
    }

    for (const session of sessionMap.values()) {
      db.addLevelingSeconds(session.user_id, guild.id, Math.max(0, Math.floor((now - session.joined_at) / 1000)));
      db.deleteLevelingSession(session.user_id, guild.id);

      const member = guild.members.cache.get(session.user_id) || await guild.members.fetch(session.user_id).catch(() => null);
      if (member) {
        await syncMemberLevelingRoles(member, now);
      }
    }
  }
}

const commands = [
  new SlashCommandBuilder()
    .setName('送金')
    .setDescription('指定ユーザーに送金します')
    .addUserOption(opt => opt.setName('ユーザー').setDescription('送金先のユーザー').setRequired(true))
    .addIntegerOption(opt => opt.setName('金額').setDescription('送金する金額').setRequired(true).setMinValue(1)),

  new SlashCommandBuilder()
    .setName('送金ログチャンネル')
    .setDescription('[管理者] 送金ログを通知するチャンネルを設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(opt => opt.setName('チャンネル').setDescription('ログチャンネル').setRequired(true).addChannelTypes(ChannelType.GuildText)),

  new SlashCommandBuilder()
    .setName('付与ログチャンネル')
    .setDescription('[管理者] 通貨付与ログを通知するチャンネルを設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(opt => opt.setName('チャンネル').setDescription('ログチャンネル').setRequired(true).addChannelTypes(ChannelType.GuildText)),

  new SlashCommandBuilder()
    .setName('減額ログチャンネル')
    .setDescription('[管理者] 通貨減額ログを通知するチャンネルを設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(opt => opt.setName('チャンネル').setDescription('ログチャンネル').setRequired(true).addChannelTypes(ChannelType.GuildText)),

  new SlashCommandBuilder()
    .setName('通貨単位設定')
    .setDescription('[管理者] 通貨の単位を設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt => opt.setName('単位').setDescription('通貨の単位').setRequired(true).setMaxLength(20)),

  new SlashCommandBuilder()
    .setName('自販機パネル設置')
    .setDescription('[管理者] 自販機パネルを設置します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt => opt.setName('パネルid').setDescription('パネル識別子(英数字/ _ / -)').setRequired(true).setMaxLength(20))
    .addChannelOption(opt => opt.setName('チャンネル').setDescription('設置先チャンネル').setRequired(true).addChannelTypes(ChannelType.GuildText))
    .addStringOption(opt => opt.setName('タイトル').setDescription('パネルタイトル').setRequired(true).setMaxLength(100))
    .addStringOption(opt => opt.setName('説明').setDescription('パネル説明').setRequired(true).setMaxLength(1000)),

  new SlashCommandBuilder()
    .setName('自販機商品設定')
    .setDescription('[管理者] 自販機の商品を設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub => sub
      .setName('設定')
      .setDescription('商品を設定または更新します')
      .addStringOption(opt => opt.setName('パネルid').setDescription('対象パネルID').setRequired(true).setMaxLength(20))
      .addIntegerOption(opt => opt.setName('スロット').setDescription('ボタンスロット(1-5)').setRequired(true).setMinValue(1).setMaxValue(5))
      .addStringOption(opt => opt.setName('商品名').setDescription('表示する商品名').setRequired(true).setMaxLength(80))
      .addRoleOption(opt => opt.setName('ロール').setDescription('付与するロール').setRequired(true))
      .addIntegerOption(opt => opt.setName('値段').setDescription('購入価格').setRequired(true).setMinValue(1))
      .addIntegerOption(opt => opt.setName('時間').setDescription('有効時間（分）').setRequired(true).setMinValue(1))
    )
    .addSubcommand(sub => sub
      .setName('削除')
      .setDescription('商品を削除します')
      .addStringOption(opt => opt.setName('パネルid').setDescription('対象パネルID').setRequired(true).setMaxLength(20))
      .addIntegerOption(opt => opt.setName('スロット').setDescription('削除するスロット(1-5)').setRequired(true).setMinValue(1).setMaxValue(5))
    )
    .addSubcommand(sub => sub
      .setName('一覧')
      .setDescription('商品一覧を表示します')
      .addStringOption(opt => opt.setName('パネルid').setDescription('対象パネルID').setRequired(true).setMaxLength(20))
      .addStringOption(opt => opt
        .setName('表示')
        .setDescription('表示方法')
        .addChoices(
          { name: '公開', value: 'public' },
          { name: '非公開', value: 'hidden' },
        ))
    ),

  new SlashCommandBuilder()
    .setName('自販機ログチャンネル')
    .setDescription('[管理者] 自販機購入ログの送信先を設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt => opt.setName('パネルid').setDescription('対象パネルID').setRequired(true).setMaxLength(20))
    .addChannelOption(opt => opt.setName('チャンネル').setDescription('ログチャンネル').setRequired(true).addChannelTypes(ChannelType.GuildText)),

  new SlashCommandBuilder()
    .setName('vc自販機パネル設置')
    .setDescription('[管理者] VC自販機パネルを設置します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt => opt.setName('パネルid').setDescription('パネル識別子(英数字/ _ / -)').setRequired(true).setMaxLength(20))
    .addChannelOption(opt => opt.setName('チャンネル').setDescription('設置先チャンネル').setRequired(true).addChannelTypes(ChannelType.GuildText))
    .addStringOption(opt => opt.setName('タイトル').setDescription('パネルタイトル').setRequired(true).setMaxLength(100))
    .addStringOption(opt => opt.setName('説明').setDescription('パネル説明').setRequired(true).setMaxLength(1000)),

  new SlashCommandBuilder()
    .setName('vc自販機パネル削除')
    .setDescription('[管理者] VC自販機パネルを削除します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt => opt.setName('パネルid').setDescription('削除するパネルID').setRequired(true).setMaxLength(20)),

  new SlashCommandBuilder()
    .setName('vc自販機商品設定')
    .setDescription('[管理者] VC自販機の商品を設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub => sub
      .setName('設定')
      .setDescription('商品を設定または更新します')
      .addStringOption(opt => opt.setName('パネルid').setDescription('対象パネルID').setRequired(true).setMaxLength(20))
      .addIntegerOption(opt => opt.setName('スロット').setDescription('ボタンスロット(1-5)').setRequired(true).setMinValue(1).setMaxValue(5))
      .addStringOption(opt => opt.setName('商品名').setDescription('表示する商品名').setRequired(true).setMaxLength(80))
      .addChannelOption(opt => opt.setName('対象vc').setDescription('設定対象のVC').setRequired(true).addChannelTypes(ChannelType.GuildVoice))
      .addStringOption(opt => opt
        .setName('公開設定')
        .setDescription('適用する公開設定')
        .setRequired(true)
        .addChoices(
          { name: '公開', value: 'public' },
          { name: '非公開', value: 'private' },
        ))
      .addIntegerOption(opt => opt.setName('値段').setDescription('購入価格').setRequired(true).setMinValue(1))
      .addIntegerOption(opt => opt.setName('時間').setDescription('有効時間（分）').setRequired(true).setMinValue(1))
    )
    .addSubcommand(sub => sub
      .setName('削除')
      .setDescription('商品を削除します')
      .addStringOption(opt => opt.setName('パネルid').setDescription('対象パネルID').setRequired(true).setMaxLength(20))
      .addIntegerOption(opt => opt.setName('スロット').setDescription('削除するスロット(1-5)').setRequired(true).setMinValue(1).setMaxValue(5))
    )
    .addSubcommand(sub => sub
      .setName('一覧')
      .setDescription('商品一覧を表示します')
      .addStringOption(opt => opt.setName('パネルid').setDescription('対象パネルID').setRequired(true).setMaxLength(20))
      .addStringOption(opt => opt
        .setName('表示')
        .setDescription('表示方法')
        .addChoices(
          { name: '公開', value: 'public' },
          { name: '非公開', value: 'hidden' },
        ))
    ),

  new SlashCommandBuilder()
    .setName('vc自販機ログチャンネル')
    .setDescription('[管理者] VC自販機購入ログの送信先を設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt => opt.setName('パネルid').setDescription('対象パネルID').setRequired(true).setMaxLength(20))
    .addChannelOption(opt => opt.setName('チャンネル').setDescription('ログチャンネル').setRequired(true).addChannelTypes(ChannelType.GuildText)),

  new SlashCommandBuilder()
    .setName('面接通過許可ロール')
    .setDescription('[管理者] /面接通過 を実行できる許可ロールを設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption(opt => opt.setName('ロール').setDescription('許可するロール').setRequired(true)),

  new SlashCommandBuilder()
    .setName('面接設定')
    .setDescription('[管理者] /面接通過 実行時のアクションを設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption(opt => opt.setName('外すロール').setDescription('外すロール').setRequired(true))
    .addRoleOption(opt => opt.setName('付与するロール').setDescription('付与するロール').setRequired(true))
    .addIntegerOption(opt => opt.setName('付与金額').setDescription('一人当たりの付与金額').setRequired(true).setMinValue(0)),

  new SlashCommandBuilder()
    .setName('評価期限設定')
    .setDescription('[管理者] 評価期限日数と評価期限表示対象ロールを設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addIntegerOption(opt => opt.setName('日数').setDescription('面接通過日からの評価期限日数').setRequired(true).setMinValue(0))
    .addRoleOption(opt => opt.setName('対象ロール').setDescription('評価期限を表示する対象ロール').setRequired(true)),

  new SlashCommandBuilder()
    .setName('ロール表示除外設定')
    .setDescription('[管理者] /自分 で対象外メンバーに表示するロールを最大3つ設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption(opt => opt.setName('表示ロール1').setDescription('表示するロール1').setRequired(false))
    .addRoleOption(opt => opt.setName('表示ロール2').setDescription('表示するロール2').setRequired(false))
    .addRoleOption(opt => opt.setName('表示ロール3').setDescription('表示するロール3').setRequired(false)),

  new SlashCommandBuilder()
    .setName('面接通過ログチャンネル')
    .setDescription('[管理者] 面接通過ログを通知するチャンネルを設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(opt => opt.setName('チャンネル').setDescription('ログチャンネル').setRequired(true).addChannelTypes(ChannelType.GuildText)),

  new SlashCommandBuilder()
    .setName('レベリングログチャンネル')
    .setDescription('[管理者] レベルアップログを通知するチャンネルを設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(opt => opt.setName('チャンネル').setDescription('ログチャンネル').setRequired(true).addChannelTypes(ChannelType.GuildText)),

  new SlashCommandBuilder()
    .setName('面接通過')
    .setDescription('VCにいるメンバーに面接通過処理を一括実行します'),

  new SlashCommandBuilder()
    .setName('自分')
    .setDescription('自分の残高とVCレベルを確認します')
    .addStringOption(opt => opt
      .setName('表示')
      .setDescription('表示方法')
      .addChoices(
        { name: '公開', value: 'public' },
        { name: '非公開', value: 'hidden' },
      )),

  new SlashCommandBuilder()
    .setName('レベリング設定')
    .setDescription('[管理者] VC参加時間レベリングを設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub => sub
      .setName('時間設定')
      .setDescription('レベルごとの必要VC参加時間を設定します')
      .addIntegerOption(opt => opt.setName('レベル').setDescription('設定対象の現在レベル').setRequired(true).setMinValue(1))
      .addIntegerOption(opt => opt.setName('必要分').setDescription('次のレベルに必要な分数').setRequired(true).setMinValue(1))
    )
    .addSubcommand(sub => sub
      .setName('時間一括設定')
      .setDescription('開始レベルから10レベル分の必要VC参加時間をまとめて設定します')
      .addIntegerOption(opt => opt.setName('開始レベル').setDescription('設定開始レベル').setRequired(true).setMinValue(1))
      .addIntegerOption(opt => opt.setName('必要分').setDescription('10レベル分の次のレベルに必要な分数').setRequired(true).setMinValue(1))
    )
    .addSubcommand(sub => sub
      .setName('ロール設定')
      .setDescription('レベル範囲に対応するロールを設定します')
      .addIntegerOption(opt => opt.setName('開始レベル').setDescription('適用開始レベル').setRequired(true).setMinValue(1))
      .addIntegerOption(opt => opt.setName('終了レベル').setDescription('適用終了レベル').setRequired(true).setMinValue(1))
      .addRoleOption(opt => opt.setName('ロール').setDescription('付与するロール').setRequired(true))
    )
    .addSubcommand(sub => sub
      .setName('表示')
      .setDescription('現在のレベリング設定を表示します')
    ),

  new SlashCommandBuilder()
    .setName('ユーザー情報')
    .setDescription('[開発者専用] 指定ユーザーの残高とVCレベルを確認します')
    .addUserOption(opt => opt.setName('ユーザー').setDescription('確認対象のユーザー').setRequired(true))
    .addStringOption(opt => opt
      .setName('表示')
      .setDescription('表示方法')
      .addChoices(
        { name: '公開', value: 'public' },
        { name: '非公開', value: 'hidden' },
      )),

  new SlashCommandBuilder()
    .setName('vc接続時間ランキング')
    .setDescription('VC接続時間のTOP10を表示します')
    .addStringOption(opt => opt
      .setName('表示')
      .setDescription('表示方法')
      .addChoices(
        { name: '公開', value: 'public' },
        { name: '非公開', value: 'hidden' },
      )),

  new SlashCommandBuilder()
    .setName('vc接続時間リセット')
    .setDescription('[開発者専用] 指定ユーザーのVC接続時間をリセットします')
    .addUserOption(opt => opt.setName('ユーザー').setDescription('リセット対象のユーザー').setRequired(true)),

  new SlashCommandBuilder()
    .setName('残高全額リセット')
    .setDescription('[開発者専用] 指定ユーザーの残高を0にします')
    .addUserOption(opt => opt.setName('ユーザー').setDescription('リセット対象のユーザー').setRequired(true)),

  new SlashCommandBuilder()
    .setName('vc接続時間全リセット')
    .setDescription('[開発者専用] 全ユーザーのVC接続時間をリセットします'),

  new SlashCommandBuilder()
    .setName('残高全額全リセット')
    .setDescription('[開発者専用] 全ユーザーの残高を0にします'),

  new SlashCommandBuilder()
    .setName('評価リセット')
    .setDescription('[開発者専用] 評価情報をリセットします（ユーザー未指定で全員）')
    .addUserOption(opt => opt.setName('ユーザー').setDescription('リセット対象ユーザー').setRequired(false)),

  new SlashCommandBuilder()
    .setName('評価一覧')
    .setDescription('[開発者専用] 評価情報の一覧を表示します')
    .addStringOption(opt => opt
      .setName('表示')
      .setDescription('表示方法')
      .addChoices(
        { name: '公開', value: 'public' },
        { name: '非公開', value: 'hidden' },
      )),

  new SlashCommandBuilder()
    .setName('給与設定')
    .setDescription('[管理者] ロールごとの給与設定を保存します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption(opt => opt.setName('ロール').setDescription('対象ロール').setRequired(true))
    .addIntegerOption(opt => opt.setName('金額').setDescription('1回あたりの付与金額').setRequired(true).setMinValue(1)),

  new SlashCommandBuilder()
    .setName('給与設定解除')
    .setDescription('[管理者] ロールごとの給与設定を解除します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption(opt => opt.setName('ロール').setDescription('対象ロール').setRequired(true)),

  new SlashCommandBuilder()
    .setName('給与設定一覧')
    .setDescription('[管理者] ロールごとの給与設定一覧を表示します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt => opt
      .setName('表示')
      .setDescription('表示方法')
      .addChoices(
        { name: '公開', value: 'public' },
        { name: '非公開', value: 'hidden' },
      )),

  new SlashCommandBuilder()
    .setName('給与一括付与')
    .setDescription('[管理者] 指定ロールのメンバーへ給与を一括付与します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption(opt => opt.setName('ロール').setDescription('対象ロール').setRequired(true)),

  new SlashCommandBuilder()
    .setName('給与全ロール一括付与')
    .setDescription('[管理者] 設定済みロールすべてに給与を一括付与します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('付与')
    .setDescription('[管理者] 指定ユーザーに通貨を付与します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(opt => opt.setName('ユーザー').setDescription('付与するユーザー').setRequired(true))
    .addIntegerOption(opt => opt.setName('金額').setDescription('付与する金額').setRequired(true).setMinValue(1)),

  new SlashCommandBuilder()
    .setName('減額')
    .setDescription('[管理者] 指定ユーザーから通貨を減額します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(opt => opt.setName('ユーザー').setDescription('減額するユーザー').setRequired(true))
    .addIntegerOption(opt => opt.setName('金額').setDescription('減額する金額').setRequired(true).setMinValue(1)),

  new SlashCommandBuilder()
    .setName('コマンド一覧')
    .setDescription('[管理者・開発者] 残すコマンドの一覧を表示します')
    .addStringOption(opt => opt
      .setName('表示')
      .setDescription('表示方法')
      .setRequired(true)
      .addChoices(
        { name: '公開', value: 'public' },
        { name: '非公開', value: 'hidden' },
      )),

  new SlashCommandBuilder()
    .setName('設定状況')
    .setDescription('[開発者専用] サーバー設定状況を表示します')
    .addStringOption(opt => opt
      .setName('表示')
      .setDescription('表示方法')
      .setRequired(true)
      .addChoices(
        { name: '公開', value: 'public' },
        { name: '非公開', value: 'hidden' },
      )),

  new SlashCommandBuilder()
    .setName('bot情報')
    .setDescription('[開発者専用] Bot参加サーバー一覧と招待リンクを表示します')
    .addStringOption(opt => opt
      .setName('表示')
      .setDescription('表示方法')
      .setRequired(true)
      .addChoices(
        { name: '公開', value: 'public' },
        { name: '非公開', value: 'hidden' },
      )),

  ...gachaCommandBuilders,
].map(cmd => cmd.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    console.log('スラッシュコマンドを登録中...');
    for (const command of commands) {
      await rest.post(Routes.applicationCommands(CLIENT_ID), { body: command });
    }
    console.log('スラッシュコマンドの登録が完了しました');
  } catch (error) {
    console.error('コマンド登録エラー:', error);
  }
}

function buildTransferLogEmbed({ userId, targetId, amount, senderBalance, receiverBalance, unit }) {
  return new EmbedBuilder()
    .setTitle('💸 送金ログ')
    .setColor(0x5865f2)
    .addFields(
      { name: '送金者', value: `<@${userId}>`, inline: true },
      { name: '受取者', value: `<@${targetId}>`, inline: true },
      { name: '金額', value: `${amount.toLocaleString()} ${unit}`, inline: true },
      { name: '送金者残高', value: `${senderBalance.toLocaleString()} ${unit}`, inline: true },
      { name: '受取者残高', value: `${receiverBalance.toLocaleString()} ${unit}`, inline: true },
    )
    .setTimestamp();
}

function buildGrantLogEmbed({ executorId, targetId, amount, balance, unit }) {
  return new EmbedBuilder()
    .setTitle('💎 通貨付与ログ')
    .setColor(0xfee75c)
    .addFields(
      { name: '実行者', value: `<@${executorId}>`, inline: true },
      { name: '対象ユーザー', value: `<@${targetId}>`, inline: true },
      { name: '付与金額', value: `${amount.toLocaleString()} ${unit}`, inline: true },
      { name: '付与後残高', value: `${balance.toLocaleString()} ${unit}`, inline: true },
    )
    .setTimestamp();
}

function buildDeductionLogEmbed({ executorId, targetId, amount, balance, unit }) {
  return new EmbedBuilder()
    .setTitle('📉 通貨減額ログ')
    .setColor(0xed4245)
    .addFields(
      { name: '実行者', value: `<@${executorId}>`, inline: true },
      { name: '対象ユーザー', value: `<@${targetId}>`, inline: true },
      { name: '減額金額', value: `${amount.toLocaleString()} ${unit}`, inline: true },
      { name: '減額後残高', value: `${balance.toLocaleString()} ${unit}`, inline: true },
    )
    .setTimestamp();
}

function buildInterviewLogEmbed({ executorId, successCount, grantAmount, removeRoleId, addRoleId, users, unit }) {
  return new EmbedBuilder()
    .setTitle('🎉 面接通過ログ')
    .setColor(0x57f287)
    .addFields(
      { name: '実行者', value: `<@${executorId}>`, inline: true },
      { name: '処理人数', value: `${successCount}人`, inline: true },
      { name: '付与金額（一人当たり）', value: `${grantAmount.toLocaleString()} ${unit}`, inline: true },
      { name: '外したロール', value: `<@&${removeRoleId}>`, inline: true },
      { name: '付与したロール', value: `<@&${addRoleId}>`, inline: true },
      { name: '対象ユーザー', value: users.length > 0 ? users.map(id => `<@${id}>`).join('\n') : 'なし', inline: false },
    )
    .setTimestamp();
}

async function sendPagedEmbeds(interaction, embeds, hidden) {
  const flags = hidden ? MessageFlags.Ephemeral : undefined;
  const first = embeds.slice(0, 10);

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ embeds: first });
  } else {
    await interaction.reply({ embeds: first, flags });
  }

  for (let i = 10; i < embeds.length; i += 10) {
    await interaction.followUp({ embeds: embeds.slice(i, i + 10), flags });
  }
}

client.once('ready', async (c) => {
  console.log(`ログイン成功: ${c.user.tag}`);
  await registerCommands();
  await reconcileLevelingSessions().catch(error => console.error('レベリング再同期エラー:', error));
  await processVendingExpirations().catch(error => console.error('自販機期限処理エラー:', error));
  await processVcVendingExpirations().catch(error => console.error('VC自販機期限処理エラー:', error));
  const interval = setInterval(() => {
    processActiveLevelingSessions().catch(error => console.error('レベリング定期同期エラー:', error));
  }, 5 * 60 * 1000);
  interval.unref();

  const vendingInterval = setInterval(() => {
    processVendingExpirations().catch(error => console.error('自販機期限処理エラー:', error));
    processVcVendingExpirations().catch(error => console.error('VC自販機期限処理エラー:', error));
  }, 60 * 1000);
  vendingInterval.unref();
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  const guildId = newState.guild.id;
  const now = Date.now();

  if (newState.member?.user?.bot) return;

  try {
    const joined = !oldState.channelId && !!newState.channelId;
    const left = !!oldState.channelId && !newState.channelId;
    const moved = !!oldState.channelId && !!newState.channelId && oldState.channelId !== newState.channelId;

    if (!joined && !left && !moved) return;

    if (joined) {
      db.upsertLevelingSession(newState.id, guildId, newState.channelId, now);
      if (newState.member) {
        await syncMemberLevelingRoles(newState.member, now);
      }
      return;
    }

    if (moved) {
      db.updateLevelingSessionChannel(newState.id, guildId, newState.channelId);
      if (newState.member) {
        await syncMemberLevelingRoles(newState.member, now);
      }
      return;
    }

    if (left) {
      const session = db.getActiveLevelingSession(oldState.id, guildId);
      if (session) {
        db.addLevelingSeconds(oldState.id, guildId, Math.max(0, Math.floor((now - session.joined_at) / 1000)));
        db.deleteLevelingSession(oldState.id, guildId);
      }

      const member = oldState.member || await oldState.guild.members.fetch(oldState.id).catch(() => null);
      if (member) {
        await syncMemberLevelingRoles(member, now);
      }
    }
  } catch (error) {
    console.error('voiceStateUpdate レベリングエラー:', error);
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.guild) return;

  try {
    if (interaction.isButton() && interaction.customId.startsWith('boxgacha:')) {
      await handleGachaButtonInteraction(interaction, {
        db,
        getUnit,
        isTextBasedChannel,
        sendToConfiguredChannel,
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('vending_buy:')) {
      const [prefix, panelKeyRaw, slotRaw] = interaction.customId.split(':');
      if (prefix !== 'vending_buy') return;

      const panelKey = normalizeVendingPanelKey(panelKeyRaw);
      if (!isValidVendingPanelKey(panelKey)) {
        await interaction.reply({ content: '❌ 無効なパネルIDです。', flags: MessageFlags.Ephemeral });
        return;
      }
      const slot = Number(slotRaw);
      const panel = db.getVendingPanel(interaction.guild.id, panelKey);
      if (!panel || panel.message_id !== interaction.message.id || panel.channel_id !== interaction.channelId) {
        await interaction.reply({ content: '❌ この自販機パネルは無効です。', flags: MessageFlags.Ephemeral });
        return;
      }

      const product = db.getVendingProduct(interaction.guild.id, panelKey, slot);
      if (!product) {
        await interaction.reply({ content: '❌ この商品は現在購入できません。', flags: MessageFlags.Ephemeral });
        return;
      }

      const member = interaction.member;
      if (!member || member.user.bot) {
        await interaction.reply({ content: '❌ 購入できませんでした。', flags: MessageFlags.Ephemeral });
        return;
      }

      const beforeBalance = db.getBalance(member.id, interaction.guild.id);
      if (beforeBalance < product.price) {
        await interaction.reply({ content: `❌ 残高不足です。必要: ${product.price.toLocaleString()} ${getUnit(interaction.guild.id)}`, flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      db.subtractBalance(member.id, interaction.guild.id, product.price);
      try {
        await member.roles.add(product.role_id);
      } catch (_) {
        db.addBalance(member.id, interaction.guild.id, product.price);
        await interaction.editReply({ content: '❌ ロール付与に失敗したため購入をキャンセルしました。' });
        return;
      }

      const currentPurchase = db.getVendingPurchase(interaction.guild.id, member.id, product.role_id);
      const baseTime = currentPurchase ? Math.max(Date.now(), currentPurchase.expires_at) : Date.now();
      const expiresAt = baseTime + (product.duration_minutes * 60 * 1000);
      db.upsertVendingPurchase(interaction.guild.id, member.id, product.role_id, expiresAt);

      const unit = getUnit(interaction.guild.id);
      const afterBalance = db.getBalance(member.id, interaction.guild.id);
      await interaction.editReply({
        content: [
          `✅ **${product.label}** を購入しました。（パネル: ${panelKey}）`,
          `付与ロール: <@&${product.role_id}>`,
          `期限: ${formatDateTime(expiresAt)}（${product.duration_minutes}分）`,
          `残高: ${afterBalance.toLocaleString()} ${unit}`,
        ].join('\n'),
      });

      const logChannelId = db.getVendingLogChannel(interaction.guild.id, panelKey);
      await sendToConfiguredChannel(interaction.guild, logChannelId, {
        embeds: [buildVendingPurchaseLogEmbed({
          buyerId: member.id,
          roleId: product.role_id,
          label: product.label,
          price: product.price,
          durationMinutes: product.duration_minutes,
          expiresAt,
          unit,
        })],
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('vc_vending_buy:')) {
      const [prefix, panelKeyRaw, slotRaw] = interaction.customId.split(':');
      if (prefix !== 'vc_vending_buy') return;

      const panelKey = normalizeVendingPanelKey(panelKeyRaw);
      if (!isValidVendingPanelKey(panelKey)) {
        await interaction.reply({ content: '❌ 無効なパネルIDです。', flags: MessageFlags.Ephemeral });
        return;
      }
      const slot = Number(slotRaw);
      const panel = db.getVcVendingPanel(interaction.guild.id, panelKey);
      if (!panel || panel.message_id !== interaction.message.id || panel.channel_id !== interaction.channelId) {
        await interaction.reply({ content: '❌ このVC自販機パネルは無効です。', flags: MessageFlags.Ephemeral });
        return;
      }

      const product = db.getVcVendingProduct(interaction.guild.id, panelKey, slot);
      if (!product) {
        await interaction.reply({ content: '❌ この商品は現在購入できません。', flags: MessageFlags.Ephemeral });
        return;
      }

      const member = interaction.member;
      if (!member || member.user.bot) {
        await interaction.reply({ content: '❌ 購入できませんでした。', flags: MessageFlags.Ephemeral });
        return;
      }

      const voiceChannel = interaction.guild.channels.cache.get(product.voice_channel_id);
      if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
        await interaction.reply({ content: '❌ 対象VCが存在しないため購入できません。', flags: MessageFlags.Ephemeral });
        return;
      }

      const beforeBalance = db.getBalance(member.id, interaction.guild.id);
      if (beforeBalance < product.price) {
        await interaction.reply({ content: `❌ 残高不足です。必要: ${product.price.toLocaleString()} ${getUnit(interaction.guild.id)}`, flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      db.subtractBalance(member.id, interaction.guild.id, product.price);

      let effectiveVoiceChannelId = product.voice_channel_id;
      let effectiveTextChannelId = null;
      let isTemporaryRoom = 0;
      let privateRoom = null;
      try {
        if (product.visibility_mode === 'private') {
          const existingPurchase = db.getVcVendingPurchaseByBuyerAndTemplate(interaction.guild.id, member.id, product.voice_channel_id);
          const isInExistingRoom = existingPurchase && existingPurchase.is_temporary && member.voice.channelId === existingPurchase.voice_channel_id;

          if (isInExistingRoom) {
            effectiveVoiceChannelId = existingPurchase.voice_channel_id;
            effectiveTextChannelId = existingPurchase.text_channel_id || null;
            isTemporaryRoom = 1;
          } else {
            const expiresAtForRoom = Date.now() + (product.duration_minutes * 60 * 1000);
            privateRoom = await createPrivateRoomFromTemplate(interaction.guild, member, voiceChannel, product.label, expiresAtForRoom);
            effectiveVoiceChannelId = privateRoom.voiceChannel.id;
            effectiveTextChannelId = privateRoom.textChannel.id;
            isTemporaryRoom = 1;
          }
        } else {
          await applyVoiceChannelVisibility(voiceChannel, product.visibility_mode);
        }
      } catch (_) {
        db.addBalance(member.id, interaction.guild.id, product.price);
        await interaction.editReply({ content: '❌ VC設定の変更に失敗したため購入をキャンセルしました。BOTの権限を確認してください。' });
        return;
      }

      const currentPurchase = db.getVcVendingPurchase(interaction.guild.id, effectiveVoiceChannelId);
      const sameMode = currentPurchase && currentPurchase.mode === product.visibility_mode && Number(currentPurchase.is_temporary) === isTemporaryRoom;
      const baseTime = sameMode ? Math.max(Date.now(), currentPurchase.expires_at) : Date.now();
      const expiresAt = baseTime + (product.duration_minutes * 60 * 1000);
      db.upsertVcVendingPurchase(interaction.guild.id, effectiveVoiceChannelId, product.visibility_mode, member.id, expiresAt, isTemporaryRoom, product.voice_channel_id, effectiveTextChannelId);

      if (isTemporaryRoom && currentPurchase && sameMode && member.voice.channelId === currentPurchase.voice_channel_id) {
        const extendMessage = `✅ 部屋の利用時間を延長しました。\n延長後の終了時刻: ${formatDateTime(expiresAt)}`;
        await sendPrivateRoomNotice(interaction.guild, effectiveVoiceChannelId, extendMessage).catch(() => null);
      }

      const unit = getUnit(interaction.guild.id);
      const afterBalance = db.getBalance(member.id, interaction.guild.id);
      await interaction.editReply({
        content: [
          `✅ **${product.label}** を購入しました。（パネル: ${panelKey}）`,
          `対象VC: <#${effectiveVoiceChannelId}>`,
          `設定: ${getVcVisibilityLabel(product.visibility_mode)}`,
          `期限: ${formatDateTime(expiresAt)}（${product.duration_minutes}分）`,
          `残高: ${afterBalance.toLocaleString()} ${unit}`,
        ].join('\n'),
      });

      const logChannelId = db.getVcVendingLogChannel(interaction.guild.id, panelKey);
      await sendToConfiguredChannel(interaction.guild, logChannelId, {
        embeds: [buildVcVendingPurchaseLogEmbed({
          buyerId: member.id,
          label: product.label,
          voiceChannelId: effectiveVoiceChannelId,
          visibilityMode: product.visibility_mode,
          price: product.price,
          durationMinutes: product.duration_minutes,
          expiresAt,
          unit,
        })],
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('vc_room_add:')) {
      const [prefix, voiceChannelId, ownerId] = interaction.customId.split(':');
      if (prefix !== 'vc_room_add') return;

      if (interaction.user.id !== ownerId) {
        await interaction.reply({ content: '❌ この操作はVCオーナーのみ実行できます。', flags: MessageFlags.Ephemeral });
        return;
      }

      const channel = interaction.guild.channels.cache.get(voiceChannelId);
      if (!channel || channel.type !== ChannelType.GuildVoice) {
        await interaction.reply({ content: '❌ 対象VCが見つかりません。', flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.reply({
        content: '追加するユーザーを選択してください。',
        components: buildPrivateVcUserSelectComponents(voiceChannelId, ownerId),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.isUserSelectMenu() && interaction.customId.startsWith('vc_room_add_select:')) {
      const [prefix, voiceChannelId, ownerId] = interaction.customId.split(':');
      if (prefix !== 'vc_room_add_select') return;

      if (interaction.user.id !== ownerId) {
        await interaction.update({ content: '❌ この操作はVCオーナーのみ実行できます。', components: [] });
        return;
      }

      const channel = interaction.guild.channels.cache.get(voiceChannelId);
      if (!channel || channel.type !== ChannelType.GuildVoice) {
        await interaction.update({ content: '❌ 対象VCが見つかりません。', components: [] });
        return;
      }

      const addedMentions = [];
      for (const userId of interaction.values) {
        if (userId === ownerId) continue;
        const memberToAdd = interaction.guild.members.cache.get(userId) || await interaction.guild.members.fetch(userId).catch(() => null);
        if (!memberToAdd || memberToAdd.user.bot) continue;

        await channel.permissionOverwrites.edit(userId, {
          ViewChannel: true,
          Connect: true,
          Speak: true,
          Stream: true,
          SendMessages: true,
          ReadMessageHistory: true,
        }).catch(() => null);
        addedMentions.push(`<@${userId}>`);
      }

      await interaction.update({
        content: addedMentions.length > 0
          ? `✅ 追加しました: ${addedMentions.join(' ')}`
          : 'ℹ️ 追加できるユーザーが選択されていませんでした。',
        components: [],
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('vc_room_remove:')) {
      const [prefix, voiceChannelId, ownerId] = interaction.customId.split(':');
      if (prefix !== 'vc_room_remove') return;

      if (interaction.user.id !== ownerId) {
        await interaction.reply({ content: '❌ この操作はVCオーナーのみ実行できます。', flags: MessageFlags.Ephemeral });
        return;
      }

      const channel = interaction.guild.channels.cache.get(voiceChannelId);
      if (!channel || channel.type !== ChannelType.GuildVoice) {
        await interaction.reply({ content: '❌ 対象VCが見つかりません。', flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.reply({
        content: '削除するユーザーを選択してください。',
        components: buildPrivateVcRemoveUserSelectComponents(voiceChannelId, ownerId),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.isUserSelectMenu() && interaction.customId.startsWith('vc_room_remove_select:')) {
      const [prefix, voiceChannelId, ownerId] = interaction.customId.split(':');
      if (prefix !== 'vc_room_remove_select') return;

      if (interaction.user.id !== ownerId) {
        await interaction.update({ content: '❌ この操作はVCオーナーのみ実行できます。', components: [] });
        return;
      }

      const channel = interaction.guild.channels.cache.get(voiceChannelId);
      if (!channel || channel.type !== ChannelType.GuildVoice) {
        await interaction.update({ content: '❌ 対象VCが見つかりません。', components: [] });
        return;
      }

      const removedMentions = [];
      for (const userId of interaction.values) {
        if (userId === ownerId) continue;
        await channel.permissionOverwrites.delete(userId).catch(() => null);
        removedMentions.push(`<@${userId}>`);
      }

      await interaction.update({
        content: removedMentions.length > 0
          ? `✅ 削除しました: ${removedMentions.join(' ')}`
          : 'ℹ️ 削除できるユーザーが選択されていませんでした。',
        components: [],
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('vc_room_rename:')) {
      const [prefix, voiceChannelId, ownerId] = interaction.customId.split(':');
      if (prefix !== 'vc_room_rename') return;

      if (interaction.user.id !== ownerId) {
        await interaction.reply({ content: '❌ この操作はVCオーナーのみ実行できます。', flags: MessageFlags.Ephemeral });
        return;
      }

      const channel = interaction.guild.channels.cache.get(voiceChannelId);
      if (!channel || channel.type !== ChannelType.GuildVoice) {
        await interaction.reply({ content: '❌ 対象VCが見つかりません。', flags: MessageFlags.Ephemeral });
        return;
      }

      const modal = new ModalBuilder()
        .setCustomId(`vc_room_rename_modal:${voiceChannelId}:${ownerId}`)
        .setTitle('部屋名変更');

      const input = new TextInputBuilder()
        .setCustomId('room_name')
        .setLabel('新しい部屋名')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100)
        .setValue(channel.name.replace(/-chat$/i, ''));

      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('vc_room_rename_modal:')) {
      const [prefix, voiceChannelId, ownerId] = interaction.customId.split(':');
      if (prefix !== 'vc_room_rename_modal') return;

      if (interaction.user.id !== ownerId) {
        await interaction.reply({ content: '❌ この操作はVCオーナーのみ実行できます。', flags: MessageFlags.Ephemeral });
        return;
      }

      const newNameRaw = interaction.fields.getTextInputValue('room_name').trim();
      if (!newNameRaw) {
        await interaction.reply({ content: '❌ 部屋名を入力してください。', flags: MessageFlags.Ephemeral });
        return;
      }

      const purchase = db.getVcVendingPurchase(interaction.guild.id, voiceChannelId);
      if (!purchase || !purchase.is_temporary) {
        await interaction.reply({ content: '❌ 秘密VCが見つかりません。', flags: MessageFlags.Ephemeral });
        return;
      }

      const voiceChannel = interaction.guild.channels.cache.get(voiceChannelId);
      const textChannel = purchase.text_channel_id ? interaction.guild.channels.cache.get(purchase.text_channel_id) : null;
      if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
        await interaction.reply({ content: '❌ 対象VCが見つかりません。', flags: MessageFlags.Ephemeral });
        return;
      }

      const safeVoiceName = newNameRaw.slice(0, 90);
      const safeTextName = `${safeVoiceName}-chat`.slice(0, 100);

      await voiceChannel.setName(safeVoiceName, 'VC自販機の部屋名変更').catch(() => null);
      if (textChannel && textChannel.type === ChannelType.GuildText) {
        await textChannel.setName(safeTextName, 'VC自販機の部屋名変更').catch(() => null);
      }

      await interaction.reply({ content: `✅ 部屋名を **${safeVoiceName}** に変更しました。`, flags: MessageFlags.Ephemeral });
      if (textChannel && isTextBasedChannel(textChannel)) {
        await textChannel.send(`✅ 部屋名を **${safeVoiceName}** に変更しました。`).catch(() => null);
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const { commandName, guild, member } = interaction;

    if (isGachaCommandName(commandName)) {
      const handled = await handleGachaCommand(interaction, {
        db,
        getUnit,
        parseNewlines,
        isTextBasedChannel,
        sendToConfiguredChannel,
      });
      if (handled) {
        return;
      }
    }

    if (commandName === '送金') {
      const target = interaction.options.getUser('ユーザー', true);
      const amount = interaction.options.getInteger('金額', true);

      if (target.bot) {
        await interaction.reply({ content: '❌ ボットへの送金はできません。', flags: MessageFlags.Ephemeral });
        return;
      }
      if (target.id === interaction.user.id) {
        await interaction.reply({ content: '❌ 自分自身への送金はできません。', flags: MessageFlags.Ephemeral });
        return;
      }

      const result = db.transfer(interaction.user.id, target.id, guild.id, amount);
      if (!result.success) {
        await interaction.reply({ content: '❌ 残高が不足しています。', flags: MessageFlags.Ephemeral });
        return;
      }

      const senderBalance = db.getBalance(interaction.user.id, guild.id);
      const receiverBalance = db.getBalance(target.id, guild.id);
      const unit = getUnit(guild.id);

      await interaction.reply({
        content: `✅ <@${target.id}> に **${amount.toLocaleString()} ${unit}** を送金しました。\n残高: **${senderBalance.toLocaleString()} ${unit}**`,
        flags: MessageFlags.Ephemeral,
      });

      const settings = db.getSettings(guild.id);
      await sendToConfiguredChannel(guild, settings.transfer_log_channel_id || settings.log_channel_id, {
        embeds: [buildTransferLogEmbed({
          userId: interaction.user.id,
          targetId: target.id,
          amount,
          senderBalance,
          receiverBalance,
          unit,
        })],
      });
      return;
    }

    if (commandName === '送金ログチャンネル') {
      const channel = interaction.options.getChannel('チャンネル', true);
      db.setTransferLogChannel(guild.id, channel.id);
      await interaction.reply({ content: `✅ 送金ログチャンネルを <#${channel.id}> に設定しました。`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (commandName === '付与ログチャンネル') {
      const channel = interaction.options.getChannel('チャンネル', true);
      db.setGrantLogChannel(guild.id, channel.id);
      await interaction.reply({ content: `✅ 付与ログチャンネルを <#${channel.id}> に設定しました。`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (commandName === '減額ログチャンネル') {
      const channel = interaction.options.getChannel('チャンネル', true);
      db.setDeductionLogChannel(guild.id, channel.id);
      await interaction.reply({ content: `✅ 減額ログチャンネルを <#${channel.id}> に設定しました。`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (commandName === '通貨単位設定') {
      const unit = interaction.options.getString('単位', true);
      db.setCurrencyUnit(guild.id, unit);
      await interaction.reply({ content: `✅ 通貨単位を **${unit}** に設定しました。`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (commandName === '自販機パネル設置') {
      const panelKey = normalizeVendingPanelKey(interaction.options.getString('パネルid', true));
      if (!isValidVendingPanelKey(panelKey)) {
        await interaction.reply({ content: '❌ パネルIDは英数字・`_`・`-` のみ、1〜20文字で指定してください。', flags: MessageFlags.Ephemeral });
        return;
      }

      const channel = interaction.options.getChannel('チャンネル', true);
      const title = interaction.options.getString('タイトル', true);
      const description = parseNewlines(interaction.options.getString('説明', true));

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const panel = {
        panel_key: panelKey,
        title,
        description,
      };
      const message = await channel.send({
        embeds: [buildVendingPanelEmbed(guild, panel)],
        components: buildVendingPanelComponents(guild.id, panelKey),
      });

      db.upsertVendingPanel(guild.id, panelKey, channel.id, message.id, title, description);
      await interaction.editReply({ content: `✅ 自販機パネルを設置しました。\nパネルID: ${panelKey}\nチャンネル: <#${channel.id}>\nメッセージID: ${message.id}` });
      return;
    }

    if (commandName === '自販機商品設定') {
      const subcommand = interaction.options.getSubcommand();

      if (subcommand === '設定') {
        const panelKey = normalizeVendingPanelKey(interaction.options.getString('パネルid', true));
        if (!isValidVendingPanelKey(panelKey)) {
          await interaction.reply({ content: '❌ パネルIDは英数字・`_`・`-` のみ、1〜20文字で指定してください。', flags: MessageFlags.Ephemeral });
          return;
        }
        const slot = interaction.options.getInteger('スロット', true);
        const label = interaction.options.getString('商品名', true);
        const role = interaction.options.getRole('ロール', true);
        const price = interaction.options.getInteger('値段', true);
        const duration = interaction.options.getInteger('時間', true);

        db.setVendingProduct(guild.id, panelKey, slot, label, role.id, price, duration);
        await refreshVendingPanel(guild, panelKey);
        await interaction.reply({
          content: `✅ 自販機商品を設定しました。\nパネルID: ${panelKey}\nスロット: ${slot}\n商品名: ${label}\nロール: <@&${role.id}>\n値段: ${price.toLocaleString()} ${getUnit(guild.id)}\n時間: ${duration}分`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === '削除') {
        const panelKey = normalizeVendingPanelKey(interaction.options.getString('パネルid', true));
        if (!isValidVendingPanelKey(panelKey)) {
          await interaction.reply({ content: '❌ パネルIDは英数字・`_`・`-` のみ、1〜20文字で指定してください。', flags: MessageFlags.Ephemeral });
          return;
        }
        const slot = interaction.options.getInteger('スロット', true);
        const changed = db.deleteVendingProduct(guild.id, panelKey, slot);
        await refreshVendingPanel(guild, panelKey);
        await interaction.reply({
          content: changed > 0 ? `✅ パネル ${panelKey} のスロット ${slot} 商品を削除しました。` : `ℹ️ パネル ${panelKey} のスロット ${slot} に商品は設定されていません。`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === '一覧') {
        const panelKey = normalizeVendingPanelKey(interaction.options.getString('パネルid', true));
        if (!isValidVendingPanelKey(panelKey)) {
          await interaction.reply({ content: '❌ パネルIDは英数字・`_`・`-` のみ、1〜20文字で指定してください。', flags: MessageFlags.Ephemeral });
          return;
        }
        const hidden = interaction.options.getString('表示') !== 'public';
        const embed = buildVendingProductListEmbed(guild, panelKey);
        await interaction.reply(hidden ? { embeds: [embed], flags: MessageFlags.Ephemeral } : { embeds: [embed] });
        return;
      }
    }

    if (commandName === '自販機ログチャンネル') {
      const panelKey = normalizeVendingPanelKey(interaction.options.getString('パネルid', true));
      if (!isValidVendingPanelKey(panelKey)) {
        await interaction.reply({ content: '❌ パネルIDは英数字・`_`・`-` のみ、1〜20文字で指定してください。', flags: MessageFlags.Ephemeral });
        return;
      }
      const channel = interaction.options.getChannel('チャンネル', true);
      db.setVendingLogChannel(guild.id, panelKey, channel.id);
      await interaction.reply({ content: `✅ パネル ${panelKey} の自販機ログチャンネルを <#${channel.id}> に設定しました。`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (commandName === 'vc自販機パネル設置') {
      const panelKey = normalizeVendingPanelKey(interaction.options.getString('パネルid', true));
      if (!isValidVendingPanelKey(panelKey)) {
        await interaction.reply({ content: '❌ パネルIDは英数字・`_`・`-` のみ、1〜20文字で指定してください。', flags: MessageFlags.Ephemeral });
        return;
      }

      const channel = interaction.options.getChannel('チャンネル', true);
      const title = interaction.options.getString('タイトル', true);
      const description = parseNewlines(interaction.options.getString('説明', true));

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const panel = {
        panel_key: panelKey,
        title,
        description,
      };
      const message = await channel.send({
        embeds: [buildVcVendingPanelEmbed(guild, panel)],
        components: buildVcVendingPanelComponents(guild.id, panelKey),
      });

      db.upsertVcVendingPanel(guild.id, panelKey, channel.id, message.id, title, description);
      await interaction.editReply({ content: `✅ VC自販機パネルを設置しました。\nパネルID: ${panelKey}\nチャンネル: <#${channel.id}>\nメッセージID: ${message.id}` });
      return;
    }

    if (commandName === 'vc自販機パネル削除') {
      const panelKey = normalizeVendingPanelKey(interaction.options.getString('パネルid', true));
      if (!isValidVendingPanelKey(panelKey)) {
        await interaction.reply({ content: '❌ パネルIDは英数字・`_`・`-` のみ、1〜20文字で指定してください。', flags: MessageFlags.Ephemeral });
        return;
      }

      const panel = db.getVcVendingPanel(guild.id, panelKey);
      if (!panel) {
        await interaction.reply({ content: `❌ パネル ${panelKey} は存在しません。`, flags: MessageFlags.Ephemeral });
        return;
      }

      let panelMessageDeleted = false;
      if (panel.channel_id && panel.message_id) {
        const panelChannel = guild.channels.cache.get(panel.channel_id);
        if (isTextBasedChannel(panelChannel)) {
          const panelMessage = await panelChannel.messages.fetch(panel.message_id).catch(() => null);
          if (panelMessage) {
            await panelMessage.delete().catch(() => null);
            panelMessageDeleted = true;
          }
        }
      }

      const result = db.deleteVcVendingPanel(guild.id, panelKey);
      await interaction.reply({
        content: [
          `✅ VC自販機パネルを削除しました。`,
          `パネルID: ${panelKey}`,
          `商品削除数: ${result.productsDeleted}件`,
          `パネルメッセージ削除: ${panelMessageDeleted ? '成功' : '未削除（既に削除済み/取得不可）'}`,
        ].join('\n'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (commandName === 'vc自販機商品設定') {
      const subcommand = interaction.options.getSubcommand();

      if (subcommand === '設定') {
        const panelKey = normalizeVendingPanelKey(interaction.options.getString('パネルid', true));
        if (!isValidVendingPanelKey(panelKey)) {
          await interaction.reply({ content: '❌ パネルIDは英数字・`_`・`-` のみ、1〜20文字で指定してください。', flags: MessageFlags.Ephemeral });
          return;
        }
        const slot = interaction.options.getInteger('スロット', true);
        const label = interaction.options.getString('商品名', true);
        const targetVc = interaction.options.getChannel('対象vc', true);
        const visibilityMode = interaction.options.getString('公開設定', true);
        const price = interaction.options.getInteger('値段', true);
        const duration = interaction.options.getInteger('時間', true);

        if (targetVc.type !== ChannelType.GuildVoice) {
          await interaction.reply({ content: '❌ 対象VCにはボイスチャンネルを指定してください。', flags: MessageFlags.Ephemeral });
          return;
        }

        db.setVcVendingProduct(guild.id, panelKey, slot, label, targetVc.id, visibilityMode, price, duration);
        await refreshVcVendingPanel(guild, panelKey);
        await interaction.reply({
          content: `✅ VC自販機商品を設定しました。\nパネルID: ${panelKey}\nスロット: ${slot}\n商品名: ${label}\n対象VC: <#${targetVc.id}>\n設定: ${getVcVisibilityLabel(visibilityMode)}\n値段: ${price.toLocaleString()} ${getUnit(guild.id)}\n時間: ${duration}分`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === '削除') {
        const panelKey = normalizeVendingPanelKey(interaction.options.getString('パネルid', true));
        if (!isValidVendingPanelKey(panelKey)) {
          await interaction.reply({ content: '❌ パネルIDは英数字・`_`・`-` のみ、1〜20文字で指定してください。', flags: MessageFlags.Ephemeral });
          return;
        }
        const slot = interaction.options.getInteger('スロット', true);
        const changed = db.deleteVcVendingProduct(guild.id, panelKey, slot);
        await refreshVcVendingPanel(guild, panelKey);
        await interaction.reply({
          content: changed > 0 ? `✅ パネル ${panelKey} のスロット ${slot} 商品を削除しました。` : `ℹ️ パネル ${panelKey} のスロット ${slot} に商品は設定されていません。`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === '一覧') {
        const panelKey = normalizeVendingPanelKey(interaction.options.getString('パネルid', true));
        if (!isValidVendingPanelKey(panelKey)) {
          await interaction.reply({ content: '❌ パネルIDは英数字・`_`・`-` のみ、1〜20文字で指定してください。', flags: MessageFlags.Ephemeral });
          return;
        }
        const hidden = interaction.options.getString('表示') !== 'public';
        const embed = buildVcVendingProductListEmbed(guild, panelKey);
        await interaction.reply(hidden ? { embeds: [embed], flags: MessageFlags.Ephemeral } : { embeds: [embed] });
        return;
      }
    }

    if (commandName === 'vc自販機ログチャンネル') {
      const panelKey = normalizeVendingPanelKey(interaction.options.getString('パネルid', true));
      if (!isValidVendingPanelKey(panelKey)) {
        await interaction.reply({ content: '❌ パネルIDは英数字・`_`・`-` のみ、1〜20文字で指定してください。', flags: MessageFlags.Ephemeral });
        return;
      }
      const channel = interaction.options.getChannel('チャンネル', true);
      db.setVcVendingLogChannel(guild.id, panelKey, channel.id);
      await interaction.reply({ content: `✅ パネル ${panelKey} のVC自販機ログチャンネルを <#${channel.id}> に設定しました。`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (commandName === '面接通過許可ロール') {
      const role = interaction.options.getRole('ロール', true);
      db.addPermittedRole(guild.id, role.id);
      await interaction.reply({ content: `✅ <@&${role.id}> を /面接通過 の許可ロールとして設定しました。`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (commandName === '面接設定') {
      const removeRole = interaction.options.getRole('外すロール', true);
      const addRole = interaction.options.getRole('付与するロール', true);
      const grantAmount = interaction.options.getInteger('付与金額', true);
      db.setInterviewSettings(guild.id, removeRole.id, addRole.id, grantAmount);
      await interaction.reply({
        content: `✅ 面接設定を更新しました。\n外すロール: <@&${removeRole.id}>\n付与するロール: <@&${addRole.id}>\n一人当たり付与金額: **${grantAmount.toLocaleString()} ${getUnit(guild.id)}**`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (commandName === '評価期限設定') {
      const days = interaction.options.getInteger('日数', true);
      const role = interaction.options.getRole('対象ロール', true);
      db.setEvaluationSettings(guild.id, days, role.id);
      await interaction.reply({
        content: `✅ 評価期限設定を更新しました。\n評価期限: **${days}日**\n対象ロール: <@&${role.id}>`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (commandName === 'ロール表示除外設定') {
      const role1 = interaction.options.getRole('表示ロール1', false);
      const role2 = interaction.options.getRole('表示ロール2', false);
      const role3 = interaction.options.getRole('表示ロール3', false);
      db.setRoleDisplayIncludeRoles(guild.id, role1 ? role1.id : null, role2 ? role2.id : null, role3 ? role3.id : null);

      const list = [role1, role2, role3].filter(Boolean).map(role => `<@&${role.id}>`);
      await interaction.reply({
        content: list.length > 0
          ? `✅ 対象外メンバーに表示するロールを設定しました。\n${list.join('\n')}`
          : '✅ 対象外メンバーに表示するロール設定を解除しました。',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (commandName === '面接通過ログチャンネル') {
      const channel = interaction.options.getChannel('チャンネル', true);
      db.setInterviewLogChannel(guild.id, channel.id);
      await interaction.reply({ content: `✅ 面接通過ログチャンネルを <#${channel.id}> に設定しました。`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (commandName === 'レベリングログチャンネル') {
      const channel = interaction.options.getChannel('チャンネル', true);
      db.setLevelingLogChannel(guild.id, channel.id);
      await interaction.reply({ content: `✅ レベリングログチャンネルを <#${channel.id}> に設定しました。`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (commandName === '面接通過') {
      if (!hasPermittedRole(member, guild.id)) {
        await interaction.reply({ content: '❌ このコマンドを実行する権限がありません。', flags: MessageFlags.Ephemeral });
        return;
      }

      const voiceChannel = member.voice.channel;
      if (!voiceChannel) {
        await interaction.reply({ content: '❌ VCに接続してからコマンドを実行してください。', flags: MessageFlags.Ephemeral });
        return;
      }

      const settings = db.getSettings(guild.id);
      if (!settings.remove_role_id || !settings.add_role_id) {
        await interaction.reply({ content: '❌ 面接設定が行われていません。先に `/面接設定` を実行してください。', flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const vcMembers = voiceChannel.members.filter(m => !m.user.bot);
      const targets = vcMembers.filter(m => m.roles.cache.has(settings.remove_role_id));
      const processedUsers = [];
      let successCount = 0;

      for (const [, vcMember] of targets) {
        try {
          await vcMember.roles.remove(settings.remove_role_id);
          await vcMember.roles.add(settings.add_role_id);
          db.setInterviewEvaluationPassedAt(vcMember.id, guild.id, Date.now());
          if ((settings.grant_amount || 0) > 0) {
            db.addBalance(vcMember.id, guild.id, settings.grant_amount);
          }
          processedUsers.push(vcMember.id);
          successCount++;
        } catch (error) {
          console.error(`メンバー処理エラー (${vcMember.id}):`, error);
        }
      }

      await interaction.editReply({ content: `✅ 面接通過処理が完了しました。\n**${successCount}人** に処理を行いました。` });

      if (processedUsers.length > 0) {
        const settingsAfter = db.getSettings(guild.id);
        await sendToConfiguredChannel(guild, settingsAfter.interview_log_channel_id, {
          embeds: [buildInterviewLogEmbed({
            executorId: interaction.user.id,
            successCount,
            grantAmount: settingsAfter.grant_amount || 0,
            removeRoleId: settingsAfter.remove_role_id,
            addRoleId: settingsAfter.add_role_id,
            users: processedUsers,
            unit: getUnit(guild.id),
          })],
        });
      }
      return;
    }

    if (commandName === '自分') {
      const hidden = interaction.options.getString('表示') !== 'public';
      const embed = buildLevelingInfoEmbed(member, guild);
      await interaction.reply(hidden ? { embeds: [embed], flags: MessageFlags.Ephemeral } : { embeds: [embed] });
      return;
    }

    if (commandName === '付与') {
      if (!hasPermittedRole(member, guild.id)) {
        await interaction.reply({ content: '❌ このコマンドを実行する権限がありません。', flags: MessageFlags.Ephemeral });
        return;
      }

      const target = interaction.options.getUser('ユーザー', true);
      const amount = interaction.options.getInteger('金額', true);
      db.addBalance(target.id, guild.id, amount);
      const newBalance = db.getBalance(target.id, guild.id);
      const unit = getUnit(guild.id);

      await interaction.reply({
        content: `✅ <@${target.id}> に **${amount.toLocaleString()} ${unit}** を付与しました。\n<@${target.id}> の残高: **${newBalance.toLocaleString()} ${unit}**`,
        flags: MessageFlags.Ephemeral,
      });

      const settings = db.getSettings(guild.id);
      await sendToConfiguredChannel(guild, settings.grant_log_channel_id, {
        embeds: [buildGrantLogEmbed({
          executorId: interaction.user.id,
          targetId: target.id,
          amount,
          balance: newBalance,
          unit,
        })],
      });
      return;
    }

    if (commandName === '減額') {
      if (!hasPermittedRole(member, guild.id)) {
        await interaction.reply({ content: '❌ このコマンドを実行する権限がありません。', flags: MessageFlags.Ephemeral });
        return;
      }

      const target = interaction.options.getUser('ユーザー', true);
      const amount = interaction.options.getInteger('金額', true);
      const beforeBalance = db.getBalance(target.id, guild.id);
      const newBalance = db.subtractBalance(target.id, guild.id, amount);
      const deducted = Math.min(amount, beforeBalance);
      const unit = getUnit(guild.id);

      await interaction.reply({
        content: `✅ <@${target.id}> から **${deducted.toLocaleString()} ${unit}** を減額しました。\n<@${target.id}> の残高: **${newBalance.toLocaleString()} ${unit}**`,
        flags: MessageFlags.Ephemeral,
      });

      const settings = db.getSettings(guild.id);
      await sendToConfiguredChannel(guild, settings.deduction_log_channel_id, {
        embeds: [buildDeductionLogEmbed({
          executorId: interaction.user.id,
          targetId: target.id,
          amount: deducted,
          balance: newBalance,
          unit,
        })],
      });
      return;
    }

    if (commandName === 'レベリング設定') {
      if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: '❌ このコマンドは管理者専用です。', flags: MessageFlags.Ephemeral });
        return;
      }

      const subcommand = interaction.options.getSubcommand();

      if (subcommand === '時間設定') {
        const level = interaction.options.getInteger('レベル', true);
        const minutes = interaction.options.getInteger('必要分', true);
        db.setLevelingThreshold(guild.id, level, minutes * 60);
        await interaction.reply({
          content: `✅ レベル **${level} → ${level + 1}** に必要なVC参加時間を **${minutes}分** に設定しました。`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === '時間一括設定') {
        const startLevel = interaction.options.getInteger('開始レベル', true);
        const minutes = interaction.options.getInteger('必要分', true);
        const endLevel = startLevel + 9;
        db.setLevelingThresholdRange(guild.id, startLevel, endLevel, minutes * 60);
        await interaction.reply({
          content: `✅ レベル **${startLevel}〜${endLevel}** の必要VC参加時間を **${minutes}分** にまとめて設定しました。`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'ロール設定') {
        const startLevel = interaction.options.getInteger('開始レベル', true);
        const endLevel = interaction.options.getInteger('終了レベル', true);
        const role = interaction.options.getRole('ロール', true);

        if (startLevel > endLevel) {
          await interaction.reply({ content: '❌ 開始レベルは終了レベル以下にしてください。', flags: MessageFlags.Ephemeral });
          return;
        }

        db.setLevelingRoleRange(guild.id, startLevel, endLevel, role.id);
        await interaction.reply({
          content: `✅ レベル **${startLevel}〜${endLevel}** に <@&${role.id}> を設定しました。`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === '表示') {
        await interaction.reply({ embeds: [buildLevelingSettingsEmbed(guild)] });
        return;
      }
    }

    if (commandName === 'ユーザー情報') {
      if (interaction.user.id !== DEVELOPER_ID) {
        await interaction.reply({ content: '❌ このコマンドは開発者専用です。', flags: MessageFlags.Ephemeral });
        return;
      }

      const targetUser = interaction.options.getUser('ユーザー', true);
      const hidden = interaction.options.getString('表示') !== 'public';
      if (hidden) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      } else {
        await interaction.deferReply();
      }

      const targetMember = guild.members.cache.get(targetUser.id) || await guild.members.fetch(targetUser.id).catch(() => null);

      if (!targetMember) {
        await interaction.editReply({ content: '❌ 対象ユーザーを取得できませんでした。' });
        return;
      }

      const embed = buildLevelingInfoEmbed(targetMember, guild);
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (commandName === 'vc接続時間ランキング') {
      const hidden = interaction.options.getString('表示') !== 'public';
      const embed = buildVcConnectionRankingEmbed(guild);
      await interaction.reply(hidden ? { embeds: [embed], flags: MessageFlags.Ephemeral } : { embeds: [embed] });
      return;
    }

    if (commandName === 'vc接続時間リセット') {
      if (interaction.user.id !== DEVELOPER_ID) {
        await interaction.reply({ content: '❌ このコマンドは開発者専用です。', flags: MessageFlags.Ephemeral });
        return;
      }

      const targetUser = interaction.options.getUser('ユーザー', true);
      const beforeSeconds = getEffectiveLevelingSeconds(targetUser.id, guild.id);
      db.setLevelingProfile(targetUser.id, guild.id, 0, 1);
      db.deleteLevelingSession(targetUser.id, guild.id);

      const targetMember = guild.members.cache.get(targetUser.id) || await guild.members.fetch(targetUser.id).catch(() => null);
      if (targetMember) {
        await syncMemberLevelingRoles(targetMember, Date.now());
      }

      await interaction.reply({
        content: `✅ <@${targetUser.id}> のVC接続時間をリセットしました。（以前: ${formatDuration(beforeSeconds)}）`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (commandName === '残高全額リセット') {
      if (interaction.user.id !== DEVELOPER_ID) {
        await interaction.reply({ content: '❌ このコマンドは開発者専用です。', flags: MessageFlags.Ephemeral });
        return;
      }

      const targetUser = interaction.options.getUser('ユーザー', true);
      const unit = getUnit(guild.id);
      const beforeBalance = db.getBalance(targetUser.id, guild.id);
      db.setBalance(targetUser.id, guild.id, 0);

      await interaction.reply({
        content: `✅ <@${targetUser.id}> の残高を全額リセットしました。（以前: ${beforeBalance.toLocaleString()} ${unit}）`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (commandName === 'vc接続時間全リセット') {
      if (interaction.user.id !== DEVELOPER_ID) {
        await interaction.reply({ content: '❌ このコマンドは開発者専用です。', flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      db.resetAllLevelingData(guild.id);

      const now = Date.now();
      let synced = 0;
      for (const [, guildMember] of guild.members.cache) {
        if (guildMember.user.bot) continue;
        await syncMemberLevelingRoles(guildMember, now);
        synced++;
      }

      await interaction.editReply({ content: `✅ 全ユーザーのVC接続時間をリセットしました。対象: ${synced}人` });
      return;
    }

    if (commandName === '残高全額全リセット') {
      if (interaction.user.id !== DEVELOPER_ID) {
        await interaction.reply({ content: '❌ このコマンドは開発者専用です。', flags: MessageFlags.Ephemeral });
        return;
      }

      const unit = getUnit(guild.id);
      const changedRows = db.resetAllBalances(guild.id);
      await interaction.reply({
        content: `✅ 全ユーザーの残高を0にリセットしました。更新件数: ${changedRows}件（単位: ${unit}）`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (commandName === '評価リセット') {
      if (interaction.user.id !== DEVELOPER_ID) {
        await interaction.reply({ content: '❌ このコマンドは開発者専用です。', flags: MessageFlags.Ephemeral });
        return;
      }

      const targetUser = interaction.options.getUser('ユーザー', false);
      if (targetUser) {
        const changed = db.deleteInterviewEvaluation(targetUser.id, guild.id);
        await interaction.reply({
          content: changed > 0
            ? `✅ <@${targetUser.id}> の評価情報をリセットしました。`
            : `ℹ️ <@${targetUser.id}> の評価情報は登録されていませんでした。`,
          flags: MessageFlags.Ephemeral,
        });
      } else {
        const changed = db.resetAllInterviewEvaluations(guild.id);
        await interaction.reply({
          content: `✅ 全ユーザーの評価情報をリセットしました。削除件数: ${changed}件`,
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    if (commandName === '評価一覧') {
      if (interaction.user.id !== DEVELOPER_ID) {
        await interaction.reply({ content: '❌ このコマンドは開発者専用です。', flags: MessageFlags.Ephemeral });
        return;
      }

      const hidden = interaction.options.getString('表示') !== 'public';
      if (hidden) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      } else {
        await interaction.deferReply();
      }

      const rows = db.getInterviewEvaluations(guild.id);
      const embeds = buildEvaluationListEmbeds(guild, rows);
      await sendPagedEmbeds(interaction, embeds, hidden);
      return;
    }

    if (commandName === '給与設定') {
      const role = interaction.options.getRole('ロール', true);
      const amount = interaction.options.getInteger('金額', true);
      const unit = getUnit(guild.id);
      db.setRoleSalarySetting(guild.id, role.id, amount);
      await interaction.reply({ content: `✅ <@&${role.id}> の給与を **${amount.toLocaleString()} ${unit}** に設定しました。`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (commandName === '給与設定解除') {
      const role = interaction.options.getRole('ロール', true);
      db.deleteRoleSalarySetting(guild.id, role.id);
      await interaction.reply({ content: `✅ <@&${role.id}> の給与設定を解除しました。`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (commandName === '給与設定一覧') {
      const hidden = interaction.options.getString('表示') !== 'public';
      const embed = buildRoleSalarySettingsEmbed(guild);
      await interaction.reply(hidden ? { embeds: [embed], flags: MessageFlags.Ephemeral } : { embeds: [embed] });
      return;
    }

    if (commandName === '給与一括付与') {
      const role = interaction.options.getRole('ロール', true);
      const salary = db.getRoleSalarySetting(guild.id, role.id);
      const unit = getUnit(guild.id);

      if (!salary) {
        await interaction.reply({ content: `❌ <@&${role.id}> の給与設定がありません。先に /給与設定 を実行してください。`, flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await grantRoleSalary(guild, role.id, salary.amount);
      if (!result.success) {
        await interaction.editReply({ content: '❌ 対象ロールが見つかりませんでした。' });
        return;
      }

      await interaction.editReply({ content: `✅ ${result.role} に給与を一括付与しました。対象: ${result.paidCount}人 / 合計: ${result.totalGranted.toLocaleString()} ${unit}` });
      return;
    }

    if (commandName === '給与全ロール一括付与') {
      const roleSalaries = db.getRoleSalarySettings(guild.id);
      const unit = getUnit(guild.id);
      if (roleSalaries.length === 0) {
        await interaction.reply({ content: '❌ 給与設定がありません。先に /給与設定 を実行してください。', flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      let totalPaidUsers = 0;
      let totalGranted = 0;
      const lines = [];

      for (const row of roleSalaries) {
        const result = await grantRoleSalary(guild, row.role_id, row.amount);
        if (!result.success) {
          lines.push(`<@&${row.role_id}>: ロール未検出`);
          continue;
        }
        totalPaidUsers += result.paidCount;
        totalGranted += result.totalGranted;
        lines.push(`${result.role}: ${result.paidCount}人 / ${result.totalGranted.toLocaleString()} ${unit}`);
      }

      await interaction.editReply({
        content: [
          '✅ 設定済みロールすべてに給与を一括付与しました。',
          `合計対象: ${totalPaidUsers}人`,
          `合計付与: ${totalGranted.toLocaleString()} ${unit}`,
          '---',
          ...lines,
        ].join('\n'),
      });
      return;
    }

    if (commandName === 'コマンド一覧') {
      if (interaction.user.id !== DEVELOPER_ID && !member.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: '❌ このコマンドは管理者または開発者専用です。', flags: MessageFlags.Ephemeral });
        return;
      }

      const hidden = interaction.options.getString('表示', true) === 'hidden';
      const embed = buildCommandListEmbed();
      await interaction.reply(hidden ? { embeds: [embed], flags: MessageFlags.Ephemeral } : { embeds: [embed] });
      return;
    }

    if (commandName === '設定状況') {
      if (interaction.user.id !== DEVELOPER_ID) {
        await interaction.reply({ content: '❌ このコマンドは開発者専用です。', flags: MessageFlags.Ephemeral });
        return;
      }

      const hidden = interaction.options.getString('表示', true) === 'hidden';
      const embed = buildStatusEmbed(guild);
      await interaction.reply(hidden ? { embeds: [embed], flags: MessageFlags.Ephemeral } : { embeds: [embed] });
      return;
    }

    if (commandName === 'bot情報') {
      if (interaction.user.id !== DEVELOPER_ID) {
        await interaction.reply({ content: '❌ このコマンドは開発者専用です。', flags: MessageFlags.Ephemeral });
        return;
      }

      const hidden = interaction.options.getString('表示', true) === 'hidden';
      if (hidden) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      } else {
        await interaction.deferReply();
      }
      const embeds = await buildBotInfoEmbeds();
      await sendPagedEmbeds(interaction, embeds, hidden);
      return;
    }
  } catch (error) {
    console.error('インタラクションエラー:', error);
    const reply = { content: '❌ 処理中にエラーが発生しました。', flags: MessageFlags.Ephemeral };
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(reply);
      } else {
        await interaction.reply(reply);
      }
    } catch (_) {}
  }
});

process.stdout.write('[STARTUP] TOKEN=' + (TOKEN ? 'OK' : 'MISSING') + ' CLIENT_ID=' + (CLIENT_ID || 'MISSING') + ' DEV=' + (DEVELOPER_ID || 'MISSING') + '\n');

process.on('SIGTERM', async () => {
  process.stdout.write('[SHUTDOWN] Received SIGTERM - process is being terminated by host\n');
  if (typeof global.__UNIFIED_PRE_SHUTDOWN_SYNC__ === 'function') {
    await global.__UNIFIED_PRE_SHUTDOWN_SYNC__('SIGTERM');
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  process.stdout.write('[SHUTDOWN] Received SIGINT\n');
  if (typeof global.__UNIFIED_PRE_SHUTDOWN_SYNC__ === 'function') {
    await global.__UNIFIED_PRE_SHUTDOWN_SYNC__('SIGINT');
  }
  process.exit(0);
});

const loginTimeout = setTimeout(() => {
  process.stdout.write('[ERROR] Login timed out after 30 seconds - possible network issue with Discord gateway\n');
  process.exit(1);
}, 30000);

process.stdout.write('[STARTUP] Calling client.login()...\n');

client.login(TOKEN).then(() => {
  clearTimeout(loginTimeout);
  process.stdout.write('[STARTUP] Login OK - bot is online\n');
}).catch((err) => {
  clearTimeout(loginTimeout);
  process.stdout.write('[LOGIN ERROR] ' + err.message + '\n');
  process.exit(1);
});