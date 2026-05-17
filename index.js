require('dotenv').config();
const { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits } = require('discord.js');
const express = require('express');
const session = require('express-session');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'supersecretkey123',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const GUILD_ID = process.env.GUILD_ID;
const MAX_ROOM_SIZE = 5;

// Discord bot
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ]
});

let queue = [];
let rooms = {};

client.once('ready', () => {
  console.log(`Bot ready as ${client.user.tag}`);
});

// Clean up empty voice channels every 30 seconds
setInterval(async () => {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;
  for (const [channelId] of Object.entries(rooms)) {
    try {
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (!channel) { delete rooms[channelId]; continue; }
      if (channel.members.size === 0) {
        await channel.delete().catch(() => {});
        delete rooms[channelId];
      }
    } catch (e) {}
  }
}, 30000);

// ─── AUTH ROUTES ──────────────────────────────────────────────────────

// Step 1: redirect to Discord login
app.get('/auth/login', (req, res) => {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'identify',
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

// Step 2: Discord redirects back here with a code
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=no_code');

  try {
    // Exchange code for access token
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.redirect('/?error=token_failed');

    // Get user info from Discord
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const user = await userRes.json();

    // Save to session
    req.session.user = {
      id: user.id,
      username: user.username,
      avatar: user.avatar
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
        : `https://cdn.discordapp.com/embed/avatars/0.png`,
    };

    res.redirect('/');
  } catch (err) {
    console.error('Auth error:', err);
    res.redirect('/?error=auth_failed');
  }
});

// Step 3: logout
app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// Get current user
app.get('/api/me', (req, res) => {
  if (req.session.user) {
    res.json({ user: req.session.user });
  } else {
    res.json({ user: null });
  }
});

// ─── QUEUE / ROOM ROUTES ──────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  next();
}

app.post('/api/join', requireAuth, async (req, res) => {
  const user = req.session.user;
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return res.status(500).json({ error: 'Bot not connected to server' });

  // Remove if already in queue
  queue = queue.filter(u => u.id !== user.id);
  queue.push({ ...user, joinedAt: Date.now() });

  console.log(`${user.username} joined queue. Size: ${queue.length}`);

  if (queue.length >= 2) {
    const roomUsers = queue.splice(0, MAX_ROOM_SIZE);
    try {
      const channel = await guild.channels.create({
        name: `room-${Date.now()}`,
        type: ChannelType.GuildVoice,
        userLimit: MAX_ROOM_SIZE,
        permissionOverwrites: [{
          id: guild.roles.everyone,
          allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.ViewChannel],
        }]
      });

      const invite = await channel.createInvite({
        maxAge: 3600,
        maxUses: MAX_ROOM_SIZE,
        unique: true,
      });

      rooms[channel.id] = {
        users: roomUsers,
        inviteUrl: invite.url,
        createdAt: Date.now(),
      };

      return res.json({
        matched: true,
        inviteUrl: invite.url,
        roomUsers: roomUsers,
        channelId: channel.id,
      });
    } catch (err) {
      console.error('Error creating channel:', err);
      queue.unshift(...roomUsers);
      return res.status(500).json({ error: 'Failed to create room' });
    }
  }

  res.json({ matched: false, queuePosition: queue.length });
});

app.get('/api/status', (req, res) => {
  res.json({ queueSize: queue.length });
});

app.post('/api/leave', requireAuth, (req, res) => {
  const user = req.session.user;
  queue = queue.filter(u => u.id !== user.id);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
client.login(process.env.DISCORD_TOKEN);
