'use strict';
/**
 * Check the MongoDB connection and show what Glance has stored.
 *   npm run db-check
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { MongoClient } = require('mongodb');

(async () => {
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
  const dbName = process.env.MONGODB_DB || 'glance';
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 4000 });
  try {
    await client.connect();
    const db = client.db(dbName);
    const users = await db.collection('users').find().toArray();
    console.log(`Connected to ${uri.replace(/\/\/[^@]*@/, '//***@')} · database "${dbName}"`);
    console.log(`users: ${users.length}`);
    for (const u of users) {
      const n = await db.collection('sessions').countDocuments({ userId: u._id });
      console.log(`  - ${u.username} (${u.displayName}) · ${n} sessions · ${u.stats ? u.stats.completed : 0} completed`);
    }
    const recent = await db.collection('sessions').find({}, { projection: { goal: 1, status: 1, stepCount: 1, startedAt: 1 } })
      .sort({ startedAt: -1 }).limit(10).toArray();
    console.log('recent sessions:');
    for (const s of recent) console.log(`  [${s.status}] ${s.goal} · ${s.stepCount} steps · ${new Date(s.startedAt).toLocaleString()}`);
  } catch (e) {
    console.error(`Could not connect to MongoDB at ${uri}: ${e.message}`);
    console.error('Is MongoDB running? (Windows: Services → MongoDB Server, or use a MongoDB Atlas URI in .env)');
    process.exitCode = 1;
  } finally {
    await client.close();
  }
})();
