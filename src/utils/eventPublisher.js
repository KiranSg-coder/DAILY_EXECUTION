const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { EVENT_TYPES, EVENT_CATEGORIES } = require('../config/eventTypes');

const EVENT_BUS_URL = (process.env.EVENT_BUS_URL || 'http://localhost:5006').replace(/\/$/, '');
const SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY;

class EventPublisher {
  async publish(eventType, eventCategory, payload, metadata = {}) {
    try {
      const event = {
        eventType,
        eventCategory,
        sourceSystem: 'DAILY_EXECUTION',
        userId: payload.userId || null,
        entityType: metadata.entityType || null,
        entityId: metadata.entityId || null,
        payload,
        metadata,
        correlationId: uuidv4(),
      };

      console.log(`[DailyExecution EventPublisher] 📤 ${eventType}`);

      const response = await axios.post(
        `${EVENT_BUS_URL}/event/publish`,
        event,
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Service-Key': SERVICE_KEY,
          },
          timeout: 5000,
        }
      );

      return response.data?.data;
    } catch (err) {
      console.error(`[DailyExecution EventPublisher] ❌ ${eventType}:`, err.message);
      return null; // do not break main flow
    }
  }
}

module.exports = new EventPublisher();