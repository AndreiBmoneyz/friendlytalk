require('dotenv').config();
const { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits } = require('discord.js');
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Discord bot setup
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ]
});

// Queue of users waiting to be matched
let queue = [];

// Active rooms: { channelId: { users: [], inviteCode, createdAt } }
let rooms = {};

const GUILD_ID = process.env.GUILD_ID;
const MAX_ROOM_SIZE = 5;

client.once('ready', () => {
  console.log(`Bot ready as ${client.user.tag}`);
});

// Clean up empty voice channels every 30 seconds
setInterval(async () => {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;

  for (const [channelId, room] of Object.entries(rooms)) {
    try {
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (!channel) { delete rooms[channelId]; continue; }

      // If channel is empty for more than 30s, delete it
      if (channel.members.size === 0) {
        await channel.delete().catch(() => {});
        delete rooms[channelId];
        console.log(`Deleted empty channel ${channelId}`);
      }
    } catch (e) {}
  }
}, 30000);

// API: Join queue and get a room
app.post('/api/join', async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });

  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return res.status(500).json({ error: 'Bot not connected to server' });

  // Add user to queue
  const user = { username, joinedAt: Date.now() };
  queue.push(user);

  console.log(`${username} joined queue. Queue size: ${queue.length}`);

  // If we have enough people, create a room
  if (queue.length >= 2) {
    // Take up to MAX_ROOM_SIZE people from queue
    const roomUsers = queue.splice(0, MAX_ROOM_SIZE);

    try {
      // Create a voice channel
      const channel = await guild.channels.create({
        name: `room-${Date.now()}`,
        type: ChannelType.GuildVoice,
        userLimit: MAX_ROOM_SIZE,
        permissionOverwrites: [
          {
            id: guild.roles.everyone,
            allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.ViewChannel],
          }
        ]
      });

      // Create an invite link (expires in 1 hour, max 5 uses)
      const invite = await channel.createInvite({
        maxAge: 3600,
        maxUses: MAX_ROOM_SIZE,
        unique: true,
      });

      rooms[channel.id] = {
        users: roomUsers.map(u => u.username),
        inviteCode: invite.code,
        inviteUrl: invite.url,
        createdAt: Date.now(),
      };

      console.log(`Room created: ${channel.id} for users: ${roomUsers.map(u => u.username).join(', ')}`);

      return res.json({
        matched: true,
        inviteUrl: invite.url,
        inviteCode: invite.code,
        roomUsers: roomUsers.map(u => u.username),
        channelId: channel.id,
      });

    } catch (err) {
      console.error('Error creating channel:', err);
      // Put users back in queue
      queue.unshift(...roomUsers);
      return res.status(500).json({ error: 'Failed to create room' });
    }
  }

  // Not enough people yet, waiting
  return res.json({ matched: false, queuePosition: queue.length });
});

// API: Check queue status (poll this every 2 seconds while waiting)
app.get('/api/status', (req, res) => {
  res.json({ queueSize: queue.length });
});

// API: Leave queue
app.post('/api/leave', (req, res) => {
  const { username } = req.body;
  queue = queue.filter(u => u.username !== username);
  res.json({ ok: true });
});

// API: Get active rooms (for debugging)
app.get('/api/rooms', (req, res) => {
  res.json({ rooms, queueSize: queue.length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

client.login(process.env.DISCORD_TOKEN);
