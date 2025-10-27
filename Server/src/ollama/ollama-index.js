import express from 'express'
import chatRoutes from './routes/chat.route.js';

const router = express.Router();

router.use('/api', chatRoutes);

export default router;