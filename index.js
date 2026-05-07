const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    EmbedBuilder
} = require("discord.js");

const { createClient } = require("@supabase/supabase-js");

const TOKEN = process.env.TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const ORDER_CHANNEL_ID = "1502007957410549830";
const ROLE_ID = "1502058557674098711";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
    partials: ["CHANNEL"]
});

// ---------------- COMMANDS ----------------

const commands = [
    new SlashCommandBuilder()
        .setName("order")
        .setDescription("Place an order")
        .addStringOption(o => o.setName("item").setRequired(true))
        .addStringOption(o => o.setName("location").setRequired(true)),

    new SlashCommandBuilder()
        .setName("claim")
        .setDescription("Claim order")
        .addIntegerOption(o => o.setName("id").setRequired(true)),

    new SlashCommandBuilder()
        .setName("status")
        .setDescription("Update order status")
        .addIntegerOption(o => o.setName("id").setRequired(true))
        .addStringOption(o =>
            o.setName("state")
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
        .addIntegerOption(o => o.setName("id").setRequired(true)),

    new SlashCommandBuilder()
        .setName("shift")
        .setDescription("Clock in/out")
        .addStringOption(o =>
            o.setName("action")
                .setRequired(true)
                .addChoices(
                    { name: "Clock In", value: "in" },
                    { name: "Clock Out", value: "out" }
                )
        ),

    new SlashCommandBuilder()
        .setName("leaderboard")
        .setDescription("Top drivers")
].map(c => c.toJSON());

// ---------------- REGISTER ----------------

const rest = new REST({ version: "10" }).setToken(TOKEN);

async function register() {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
        body: commands
    });
}

// ---------------- HELPERS ----------------

async function dm(userId, msg) {
    const user = await client.users.fetch(userId);
    try { await user.send(msg); } catch {}
}

// ---------------- AUTO EXPIRE LOOP ----------------

async function expireOrders() {
    const { data } = await supabase
        .from("orders")
        .select("*")
        .eq("status", "Pending")
        .eq("cancelled", false);

    const now = new Date();

    for (const order of data) {
        if (new Date(order.expires_at) < now) {
            await supabase
                .from("orders")
                .update({ status: "Expired" })
                .eq("id", order.id);

            await dm(order.customer_id, `⏰ Your order #${order.id} expired (no drivers claimed it).`);
        }
    }
}

setInterval(expireOrders, 60 * 1000); // every 1 min

// ---------------- BOT READY ----------------

client.once("ready", async () => {
    console.log(`Logged in as ${client.user.tag}`);
    await register();
});

// ---------------- INTERACTIONS ----------------

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    // ========== ORDER ==========
    if (interaction.commandName === "order") {
        const item = interaction.options.getString("item");
        const location = interaction.options.getString("location");

        const expires = new Date(Date.now() + 15 * 60 * 1000); // 15 min expiry

        const { data } = await supabase
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

        const channel = await client.channels.fetch(ORDER_CHANNEL_ID);

        channel.send({
            content: `<@&${ROLE_ID}> New order #${data.id}`,
            embeds: [
                new EmbedBuilder()
                    .setTitle("🍔 New Order")
                    .addFields(
                        { name: "ID", value: `${data.id}`, inline: true },
                        { name: "Item", value: item, inline: true },
                        { name: "Location", value: location }
                    )
                    .setColor("Blue")
            ]
        });

        return interaction.reply({
            content: `✅ Order placed (#${data.id})`,
            ephemeral: true
        });
    }

    // ========== CLAIM ==========
    if (interaction.commandName === "claim") {
        const id = interaction.options.getInteger("id");

        const { data: order } = await supabase
            .from("orders")
            .select("*")
            .eq("id", id)
            .single();

        if (!order || order.status !== "Pending") {
            return interaction.reply({ content: "❌ Invalid order", ephemeral: true });
        }

        await supabase
            .from("orders")
            .update({ driver_id: interaction.user.id, status: "Accepted" })
            .eq("id", id);

        await dm(order.customer_id, `🚚 Your order #${id} was claimed by ${interaction.user.tag}`);

        return interaction.reply({ content: `Claimed #${id}`, ephemeral: true });
    }

    // ========== STATUS ==========
    if (interaction.commandName === "status") {
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

        return interaction.reply({ content: `Updated #${id}`, ephemeral: true });
    }

    // ========== CANCEL ==========
    if (interaction.commandName === "cancel") {
        const id = interaction.options.getInteger("id");

        const { data: order } = await supabase
            .from("orders")
            .select("*")
            .eq("id", id)
            .single();

        if (!order) {
            return interaction.reply({ content: "❌ Not found", ephemeral: true });
        }

        if (
            order.customer_id !== interaction.user.id &&
            !interaction.member.permissions.has("Administrator")
        ) {
            return interaction.reply({ content: "❌ Not allowed", ephemeral: true });
        }

        await supabase
            .from("orders")
            .update({ cancelled: true, status: "Cancelled" })
            .eq("id", id);

        await dm(order.customer_id, `❌ Your order #${id} was cancelled`);

        return interaction.reply({ content: `Cancelled #${id}`, ephemeral: true });
    }

    // ========== SHIFT ==========
    if (interaction.commandName === "shift") {
        const action = interaction.options.getString("action");

        if (action === "in") {
            await supabase.from("shifts").insert({
                user_id: interaction.user.id,
                active: true
            });

            return interaction.reply({ content: "🟢 Clocked in", ephemeral: true });
        }

        if (action === "out") {
            await supabase
                .from("shifts")
                .update({ active: false, end_time: new Date() })
                .eq("user_id", interaction.user.id)
                .eq("active", true);

            return interaction.reply({ content: "🔴 Clocked out", ephemeral: true });
        }
    }

    // ========== LEADERBOARD ==========
    if (interaction.commandName === "leaderboard") {
        const { data } = await supabase
            .from("orders")
            .select("driver_id")
            .eq("status", "Delivered");

        const map = {};
        data.forEach(o => {
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

        return interaction.reply({
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
