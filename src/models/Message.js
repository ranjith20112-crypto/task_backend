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
  },
  { timestamps: true }
);

messageSchema.index({ conversation: 1, createdAt: -1 });

const Message =
  mongoose.models.Message || mongoose.model("Message", messageSchema);

export default Message;