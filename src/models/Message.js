import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
  {
    conversation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
      index: true,
    },

    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // Text is optional when the message carries attachments
    text: {
      type: String,
      trim: true,
      default: "",
      maxlength: 5000,
    },

    // Files are stored on disk (uploads/chat); only metadata is kept here
    attachments: [
      {
        _id: false,
        filename: { type: String, required: true },
        name: { type: String, required: true },
        size: { type: Number, default: 0 },
        mimetype: { type: String, default: "" },
      },
    ],

    // Supports read receipts later.
    readBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],

    // Optional expiry time (for disappearing / auto-cleanup messages).
    // null = the message never expires.
    expiresAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

messageSchema.index({ conversation: 1, createdAt: -1 });
messageSchema.index({ expiresAt: 1 });

/**
 * Mongo filter: only messages that have NOT expired.
 * Works both ways the controller might use it:
 *   Message.find({ conversation: id, ...notExpired() })
 *   Message.find({ conversation: id, ...notExpired })
 */
export function notExpired(now = new Date()) {
  return {
    $or: [
      { expiresAt: { $exists: false } },
      { expiresAt: null },
      { expiresAt: { $gt: now } },
    ],
  };
}
// so that `...notExpired` (without brackets) also works
notExpired.$or = [
  { expiresAt: { $exists: false } },
  { expiresAt: null },
  { expiresAt: { $gt: new Date(8640000000000000) } }, // far future = never expired
];
Object.defineProperty(notExpired, "$or", { enumerable: true });

const Message =
  mongoose.models.Message || mongoose.model("Message", messageSchema);

export default Message;
