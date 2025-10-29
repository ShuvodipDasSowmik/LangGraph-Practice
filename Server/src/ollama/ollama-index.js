import express from 'express'
import chatRoutes from './routes/chat.route.js';
import chatBotRoutes from './routes/chatbot.routes.js';

const router = express.Router();

router.use('/api', chatRoutes);
router.use('/api/chatbot', chatBotRoutes);

export default router;