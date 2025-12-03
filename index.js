const express = require("express");
const app = express();
const cors = require("cors");
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const port = process.env.PORT || 5000;

//Firebase admin
const admin = require("firebase-admin");
const serviceAccount = require("./zap-shift-server-firebase-adminsdk.json");
// const { use } = require("react");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// tracking id generator
function generateTrackingId() {
  const prefix = "TRK";
  const randomPart = Math.random().toString(36).substring(2, 8).toUpperCase();
  const timestamp = Date.now().toString().slice(-6);
  return `${prefix}-${timestamp}-${randomPart}`;
}

// Middleware
app.use(express.json());
app.use(cors());
// Firebase Middleware
const verifyFirebaseToken = async (req, res, next) => {
  const headerAuth = req.headers.authorization;
  if (!headerAuth) {
    return res.status(401).send({
      message: "Unothorized access",
    });
  }
  const token = headerAuth.split(" ")[1];
  if (!token) {
    return res.status(403).send("Unothorized access , There are no token.");
  }
  try {
    const verify = await admin.auth().verifyIdToken(token);
    req.token_email = verify.email;
    next();
  } catch (error) {
    return res.status(401).send({ message: error });
  }
};
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.ixbmwio.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();
    const db = client.db("zap_shift_db");
    const userCollection = db.collection("users");
    const parcelCollection = db.collection("parcels");
    const paymentCollection = db.collection("payments");

    // User releted api
    app.post("/users", async (req, res) => {
      try {
        const user = req.body;
        user.role = "user";
        user.createAt = new Date();
        const result = userCollection.insertOne(user);
        res.status(200).send(result);
      } catch (error) {
        res.status(500).send({ message: error });
      }
    });

    // parcel api
    app.get("/parcels", async (req, res) => {
      try {
        const { email } = req.query;
        let query = {};
        if (email) {
          query = { senderEmail: email };
        }
        const option = { sort: { createAt: -1 } };
        const result = await parcelCollection.find(query, option).toArray();
        res.status(201).json(result);
      } catch (err) {
        res.status(501).json({ error: err.message });
      }
    });

    // Find the parcel
    app.get("/parcels/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const query = { _id: new ObjectId(id) };
        const result = await parcelCollection.findOne(query);
        if (!result) {
          return res.status(404).json({ error: "Parcel not found." });
        }
        res.status(200).json(result);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    app.post("/parcels", async (req, res) => {
      try {
        const parcel = req.body;
        parcel.createAt = new Date();
        const result = await parcelCollection.insertOne(parcel);
        res.status(201).json(result);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Delete the parcel
    app.delete("/parcels/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const query = { _id: new ObjectId(id) };
        const result = await parcelCollection.deleteOne(query);
        res.status(201).json(result);
      } catch (err) {
        res.status(501).json({ error: err.message });
      }
    });

    // Payment apis
    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.cost) * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "USD",
              unit_amount: amount,
              product_data: {
                name: paymentInfo.parcelName,
              },
            },
            quantity: 1,
          },
        ],
        customer_email: paymentInfo.senderEmail,
        mode: "payment",
        metadata: {
          parcelId: paymentInfo.parcelId,
          parcelName: paymentInfo.parcelName,
        },
        success_url: `${process.env.VITE_SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.VITE_SITE_DOMAIN}/dashboard/payment-cancel`,
      });
      console.log(session);

      res.send({ url: session.url });
    });

    // User payment
    app.patch("/payment-success", async (req, res) => {
      try {
        const sessionId = req.query.session_id;

        // Validate session ID
        if (!sessionId) {
          return res
            .status(400)
            .json({ success: false, message: "Missing session_id" });
        }

        // Fetch Stripe session
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        // Validate session
        if (!session) {
          return res
            .status(404)
            .json({ success: false, message: "Invalid session" });
        }

        if (session.payment_status !== "paid") {
          return res
            .status(400)
            .json({ success: false, message: "Payment not completed" });
        }

        // Validate metadata
        if (!session.metadata?.parcelId) {
          return res
            .status(400)
            .json({ success: false, message: "Missing parcel metadata" });
        }
        const transactionId = session.payment_intent;
        // Validate
        if (!transactionId) {
          return res.status(400).json({
            success: false,
            message: "Missing transactionId",
          });
        }

        // Check payment existence
        const paymentExist = await paymentCollection.findOne({ transactionId });
        if (paymentExist) {
          return res.status(409).json({
            success: false,
            message: "Payment already processed",
            existedPayment: paymentExist,
          });
        }

        const parcelId = session.metadata.parcelId;
        const trackingId = generateTrackingId();

        // Update parcel status
        const updateResult = await parcelCollection.updateOne(
          { _id: new ObjectId(parcelId) },

          {
            $set: {
              paymentStatus: "paid",
              trackingId: trackingId,
              updatedAt: new Date(),
            },
          }
        );

        // Payment History Object
        const paymentHistory = {
          amount: session.amount_total,
          currency: session.currency,
          customerEmail: session.customer_email,
          parcelId: parcelId,
          parcelName: session.metadata.parcelName || "Unknown",
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          trackingId: trackingId,
          paidAt: new Date(),
        };

        // Insert payment log
        const paymentResult = await paymentCollection.insertOne(paymentHistory);

        return res.status(200).json({
          success: true,
          message: "Payment verified & updated successfully",
          parcelUpdate: updateResult,
          trackingId: trackingId,
          transactionId: session.payment_intent,
          paymentHistory: paymentResult,
        });
      } catch (error) {
        console.error("PAYMENT SUCCESS ERROR:", error);

        return res.status(500).json({
          success: false,
          message: "Server error while verifying payment",
          error: error.message,
        });
      }
    });

    // Get all payment history for a customer
    app.get("/payments", verifyFirebaseToken, async (req, res) => {
      try {
        const email = req.query.email;
        console.log(req.token_email);

        if (!email) {
          return res.status(400).json({
            success: false,
            message: "Missing email in query.",
          });
        }
        if (email !== req.token_email) {
          return res.status(403).send("Unothorized access, no email.");
        }
        // Get all payments for this email
        const payments = await paymentCollection
          .find({ customerEmail: email })
          .sort({ paidAt: -1 })
          .toArray();

        if (!payments || payments.length === 0) {
          return res.status(404).json({
            success: false,
            message: "No payment history found for this email.",
          });
        }

        res.status(200).json({
          success: true,
          data: payments,
        });
      } catch (error) {
        console.error(error);
        res.status(500).json({
          success: false,
          message: "Server error",
        });
      }
    });

    // User payment
    // app.patch("/payment-success", async (req, res) => {
    //   try {
    //     const sessionId = req.query.session_id;
    //     if (!sessionId) {
    //       return res.status(400).send({ error: "Missing session_id" });
    //     }
    //     const session = await stripe.checkout.sessions.retrieve(sessionId);
    //     if (session.payment_status === "paid") {
    //       const id = session.metadata.parcelId;
    //       const query = { _id: new ObjectId(id) };
    //       const update = {
    //         $set: {
    //           paymentStatus: "paid",
    //         },
    //       };
    //       const result = await parcelCollection.updateOne(query, update);
    //       const paymentHistory = {
    //         amount: session.amount_total,
    //         currency: session.currency,
    //         customerEmail: session.customer_email,
    //         parcelId: session.metadata.parcelId,
    //         parcelName: session.metadata.parcelName,
    //         transactionId: session.payment_intent,
    //         paymentStatus: session.payment_status,
    //         paidAt: new Date(),
    //         trackingId: "hello",
    //       };
    //       if (session.payment_status === "paid") {
    //         const resultPayment = await paymentCollection.insertOne(
    //           paymentHistory
    //         );

    //         return res.send({ success: true, data: resultPayment });
    //       }
    //       return res.send({ success: true, data: result });
    //     }
    //   } catch (error) {
    //     res.status(500).send({ error: "server error" });
    //   }
    // });

    // Unknown route
    // app.get("*", (req, res) => {
    //   res.sendFile(path.resolve(__dirname, "dist", "index.html"));
    // });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Zap shift server ");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
