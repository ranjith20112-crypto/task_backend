import mongoose from "mongoose";

const departmentSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Department name is required"],
      trim: true,
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    status: {
      type: String,
      enum: ["Active", "Inactive"],
      default: "Active",
    },
    // WHO created this department — for data isolation
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Created by is required"],
    },
    // ⭐⭐⭐ NEW — ORGANIZATION ISOLATION KEY (which admin owns this)
    admin_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
      default: null,
    },
  },
  { timestamps: true }
);

const Department =
  mongoose.models.Department || mongoose.model("Department", departmentSchema);

export default Department;
