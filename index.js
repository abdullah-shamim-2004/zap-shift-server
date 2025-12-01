const express = require("express");
const app = express();
const cors = require("cors");
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const port = process.env.PORT || 5000;

// Middleware
app.use(express.json());
app.use(cors());
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
    const parcelCollection = db.collection("parcels");
    const paymentCollection = db.collection("payments");

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
        if (!sessionId) {
          return res.status(400).send({ error: "Missing session_id" });
        }
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        if (session.payment_status === "paid") {
          const id = session.metadata.parcelId;
          const query = { _id: new ObjectId(id) };
          const update = {
            $set: {
              paymentStatus: "paid",
            },
          };
          const result = await parcelCollection.updateOne(query, update);
          const paymentHistory = {
            amount: session.amount_total,
            currency: session.currency,
            customerEmail: session.customer_email,
            parcelId: session.metadata.parcelId,
            parcelName: session.metadata.parcelName,
            transactionId: session.payment_intent,
            paymentStatus: session.payment_status,
            paidAt: new Date(),
            trackingId: "hello",
          };
          return res.send({ success: true, data: result });
        }
      } catch (error) {
        res.status(500).send({ error: "server error" });
      }
    });

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
