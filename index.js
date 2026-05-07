const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    EmbedBuilder
} = require("discord.js");

const { createClient } = require("@supabase/supabase-js");

// ================= ENV =================
const TOKEN = process.env.TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

// ================= CONSTANTS =================
const ORDER_CHANNEL_ID = "1502007957410549830";
const ROLE_ID = "1502058557674098711";

// ================= SUPABASE =================
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ================= CLIENT =================
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
    partials: ["CHANNEL"]
});

// ================= COMMANDS =================

const commands = [
    new SlashCommandBuilder()
        .setName("order")
        .setDescription("Place a Boosh delivery order")
        .addStringOption(o =>
            o.setName("item")
                .setDescription("Food or drink")
                .setRequired(true)
        )
        .addStringOption(o =>
            o.setName("location")
                .setDescription("Delivery location")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("claim")
        .setDescription("Claim a delivery order")
        .addIntegerOption(o =>
            o.setName("id")
                .setDescription("Order ID")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("status")
        .setDescription("Update order status")
        .addIntegerOption(o =>
            o.setName("id")
                .setDescription("Order ID")
                .setRequired(true)
        )
        .addStringOption(o =>
            o.setName("state")
                .setDescription("Status update")
                .setRequired(true)
                .addChoices(
                    { name: "Accepted", value: "Accepted" },
                    { name: "On The Way", value: "On The Way" },
                    { name: "Delivered", value: "Delivered" }
                )
        ),

    new SlashCommandBuilder()
        .setName("cancel")
        .setDescription("Cancel an order")
        .addIntegerOption(o =>
            o.setName("id")
                .setDescription("Order ID")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("shift")
        .setDescription("Clock in or out")
        .addStringOption(o =>
            o.setName("action")
                .setDescription("Clock in or out")
                .setRequired(true)
                .addChoices(
                    { name: "Clock In", value: "in" },
                    { name: "Clock Out", value: "out" }
                )
        ),

    new SlashCommandBuilder()
        .setName("leaderboard")
        .setDescription("View top drivers")
].map(c => c.toJSON());

// ================= REGISTER COMMANDS =================

const rest = new REST({ version: "10" }).setToken(TOKEN);

async function registerCommands() {
    try {
        await rest.put(
            Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
            { body: commands }
        );
        console.log("Slash commands registered.");
    } catch (err) {
        console.error("Command registration failed:", err);
    }
}

// ================= HELPERS =================

async function dm(userId, msg) {
    try {
        const user = await client.users.fetch(userId);
        await user.send(msg);
    } catch {}
}

// ================= AUTO EXPIRE =================

async function expireOrders() {
    try {
        const { data } = await supabase
            .from("orders")
            .select("*")
            .eq("status", "Pending")
            .eq("cancelled", false);

        const now = new Date();

        for (const order of data || []) {
            if (new Date(order.expires_at) < now) {
                await supabase
                    .from("orders")
                    .update({ status: "Expired" })
                    .eq("id", order.id);

                await dm(order.customer_id, `⏰ Order #${order.id} expired.`);
            }
        }
    } catch (err) {
        console.error("Expire error:", err);
    }
}

setInterval(expireOrders, 60 * 1000);

// ================= READY =================

client.once("ready", async () => {
    console.log(`Logged in as ${client.user.tag}`);
    await registerCommands();
});

// ================= INTERACTIONS =================

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    // ========== ORDER ==========
    if (interaction.commandName === "order") {
        await interaction.deferReply({ ephemeral: true });

        try {
            const item = interaction.options.getString("item");
            const location = interaction.options.getString("location");

            const expires = new Date(Date.now() + 15 * 60 * 1000);

            const { data, error } = await supabase
                .from("orders")
                .insert({
                    item,
                    location,
                    customer_id: interaction.user.id,
                    status: "Pending",
                    expires_at: expires
                })
                .select()
                .single();

            if (error) {
                console.error(error);
                return interaction.editReply("❌ Failed to create order.");
            }

            const channel = await client.channels.fetch(ORDER_CHANNEL_ID);

            await channel.send({
                content: `<@&${ROLE_ID}> New order #${data.id}`
            });

            return interaction.editReply(`✅ Order placed (#${data.id})`);

        } catch (err) {
            console.error(err);
            return interaction.editReply("❌ Error placing order.");
        }
    }

    // ========== CLAIM ==========
    if (interaction.commandName === "claim") {
        await interaction.deferReply({ ephemeral: true });

        const id = interaction.options.getInteger("id");

        const { data: order } = await supabase
            .from("orders")
            .select("*")
            .eq("id", id)
            .single();

        if (!order || order.status !== "Pending") {
            return interaction.editReply("❌ Invalid order");
        }

        await supabase
            .from("orders")
            .update({ driver_id: interaction.user.id, status: "Accepted" })
            .eq("id", id);

        await dm(order.customer_id, `🚚 Order #${id} claimed by ${interaction.user.tag}`);

        return interaction.editReply(`Claimed #${id}`);
    }

    // ========== STATUS ==========
    if (interaction.commandName === "status") {
        await interaction.deferReply({ ephemeral: true });

        const id = interaction.options.getInteger("id");
        const state = interaction.options.getString("state");

        const { data: order } = await supabase
            .from("orders")
            .select("*")
            .eq("id", id)
            .single();

        await supabase
            .from("orders")
            .update({ status: state })
            .eq("id", id);

        await dm(order.customer_id, `📦 Order #${id}: ${state}`);

        return interaction.editReply(`Updated #${id}`);
    }

    // ========== CANCEL ==========
    if (interaction.commandName === "cancel") {
        await interaction.deferReply({ ephemeral: true });

        const id = interaction.options.getInteger("id");

        const { data: order } = await supabase
            .from("orders")
            .select("*")
            .eq("id", id)
            .single();

        if (!order) return interaction.editReply("❌ Not found");

        if (
            order.customer_id !== interaction.user.id &&
            !interaction.member.permissions.has("Administrator")
        ) {
            return interaction.editReply("❌ Not allowed");
        }

        await supabase
            .from("orders")
            .update({ cancelled: true, status: "Cancelled" })
            .eq("id", id);

        await dm(order.customer_id, `❌ Order #${id} cancelled`);

        return interaction.editReply(`Cancelled #${id}`);
    }

    // ========== SHIFT ==========
    if (interaction.commandName === "shift") {
        await interaction.deferReply({ ephemeral: true });

        const action = interaction.options.getString("action");

        if (action === "in") {
            await supabase.from("shifts").insert({
                user_id: interaction.user.id,
                active: true
            });

            return interaction.editReply("🟢 Clocked in");
        }

        if (action === "out") {
            await supabase
                .from("shifts")
                .update({ active: false, end_time: new Date() })
                .eq("user_id", interaction.user.id)
                .eq("active", true);

            return interaction.editReply("🔴 Clocked out");
        }
    }

    // ========== LEADERBOARD ==========
    if (interaction.commandName === "leaderboard") {
        await interaction.deferReply();

        const { data } = await supabase
            .from("orders")
            .select("driver_id")
            .eq("status", "Delivered");

        const map = {};

        (data || []).forEach(o => {
            if (!o.driver_id) return;
            map[o.driver_id] = (map[o.driver_id] || 0) + 1;
        });

        const sorted = Object.entries(map)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);

        let desc = "";

        for (const [id, count] of sorted) {
            const user = await client.users.fetch(id);
            desc += `**${user.tag}** — ${count}\n`;
        }

        return interaction.editReply({
            embeds: [
                new EmbedBuilder()
                    .setTitle("🏆 Leaderboard")
                    .setDescription(desc || "No deliveries yet")
                    .setColor("Gold")
            ]
        });
    }
});

client.login(TOKEN);
