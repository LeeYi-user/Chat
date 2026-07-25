import { Application, Context, Router, send} from "https://deno.land/x/oak@v11.1.0/mod.ts";
import { MongoClient } from "https://deno.land/x/mongo@v0.29.4/mod.ts";
import { Session, MongoStore } from "https://deno.land/x/oak_sessions@v4.0.5/mod.ts";
import "https://deno.land/x/dotenv@v3.2.0/load.ts";

interface User
{
	"username": string;
	"password": string;
}

interface Msg
{
	"msg": string;
}

const uri = Deno.env.get("URI");

if (!uri)
{
	throw new Error("Missing required env var URI");
}

const client = new MongoClient();
await client.connect(uri);
const db = client.database("chat");

const router = new Router();
router.get("/", redir);
router.get("/public/(.*)", pub);
router.post("/sign_up", sign_up);
router.post("/sign_in", sign_in);
router.get("/wss", wss);

const app = new Application();
app.use(Session.initMiddleware(new MongoStore(db, "session"), { cookieSetOptions: { expires: new Date(3000, 1, 1) } }));
app.use(router.routes());
app.use(router.allowedMethods());

function redir(ctx: Context)
{
	ctx.response.redirect("/public/");
}

async function pub(ctx: Context)
{
	await send(ctx, ctx.request.url.pathname,
	{
		root: `${ Deno.cwd() }/`,
		index: "login.html"
	});
}

async function sign_up(ctx: Context)
{
	const body = ctx.request.body({ type: "form-data" });
	const data = await body.value.read();
	const accounts = await db.collection<User>("users").countDocuments({ "username": data["fields"]["username"] });

	if (accounts > 0)
	{
		ctx.response.body = "sign up fail";
	}
	else
	{
		await db.collection<User>("users").insertOne({ "username": data["fields"]["username"], "password": data["fields"]["password"] });
		ctx.response.body = "sign up success";
	}
}

async function sign_in(ctx: Context)
{
	const body = ctx.request.body({ type: "form-data" });
	const data = await body.value.read();
	const accounts = await db.collection<User>("users").countDocuments({ "username": data["fields"]["username"] });

	if (accounts == 0)
	{
		ctx.response.body = "sign in fail";
	}
	else
	{
		const password = (await db.collection<User>("users").findOne({ "username": data["fields"]["username"] }))?.password;

		if (password != data["fields"]["password"])
		{
			ctx.response.body = "sign in fail";
		}
		else
		{
			await ctx.state.session.set("user", data["fields"]["username"]);
			ctx.response.body = "sign in success";
		}
	}
}

const clients = new Map<WebSocket, string>();
const upgrades = new WeakMap<Request, Response>();

async function wss(ctx: Context)
{
	if (!ctx.isUpgradable)
	{
		ctx.throw(501);
	}

	// ctx.upgrade() hands the upgrade response to a promise that app.handle()
	// discards, so do the upgrade here and pass the response back to Deno.serve.
	const request = (ctx.request.originalRequest as unknown as { request: Request }).request;
	const { socket, response } = Deno.upgradeWebSocket(request);

	upgrades.set(request, response);
	ctx.respond = false;

	const user = await ctx.state.session.get("user");

	clients.set(socket, user);

	socket.onopen = () =>
	{
		if (user == null)
		{
			socket.send(JSON.stringify({ "command": "get out" }));
		}
		else
		{
			socket.send(JSON.stringify({ "command": "get in" }));
		}
	};

	socket.onmessage = async (event) =>
	{
		const data = JSON.parse(event.data);

		for (const key in data)
		{
			if (key == "history")
			{
				if (data[key] > 0)
				{
					const msgs = await db.collection<Msg>("msgs").find().sort({ "_id": -1 }).limit(data[key]).toArray();

					for (const data of msgs.reverse())
					{
						socket.send(JSON.stringify({ "message": data.msg }));
					}
				}

				const count = await db.collection<Msg>("msgs").countDocuments();
				socket.send(JSON.stringify({ "count": count }));
			}
			else if (key == "message")
			{
				const msg = "&lt;" + user + "&gt; " + data[key];

				await db.collection<Msg>("msgs").insertOne({ "msg": msg });

				for (const [socket, _user] of clients)
				{
					socket.send(JSON.stringify({ "message": msg }));
				}
			}
		}
	};

	socket.onclose = () =>
	{
		clients.delete(socket);
	};
}

const port = Number(Deno.env.get("PORT") ?? 8000);

console.log(`Server running at http://localhost:${ port }`);

// Deno Deploy only detects servers started with Deno.serve(), so drive oak
// through app.handle() instead of app.listen() (which uses Deno.serveHttp).
Deno.serve({ port, hostname: "0.0.0.0" }, async (request) =>
{
	const response = await app.handle(request);

	return upgrades.get(request) ?? response ?? new Response(null, { status: 404 });
});
