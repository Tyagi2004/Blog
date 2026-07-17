require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const session = require("express-session");
const { MongoStore } = require("connect-mongo");
const methodOverride = require("method-override");

const User = require("./models/User");
const Post = require("./models/Post");
const Comment = require("./models/Comment");
const { loadUser, requireAuth } = require("./middleware/auth");

const app = express();

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/devsphere";
const SESSION_SECRET = process.env.SESSION_SECRET || "devsphere-dev-secret-change-me";
const PORT = process.env.PORT || 8080;

// ---------- DB ----------
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => {
    console.error("MongoDB connection error:", err.message);
    process.exit(1);
  });

// ---------- View / middleware setup ----------
app.set("view engine", "ejs");
app.use(express.static("public"));
app.use(express.urlencoded({ extended: true }));
app.use(methodOverride("_method"));

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: MONGO_URI }),
    cookie: {
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    },
  })
);

// Pops one-time flash-style messages from the session and loads req.user
app.use((req, res, next) => {
  res.locals.errorMsg = req.session.errorMsg || null;
  res.locals.successMsg = req.session.successMsg || null;
  delete req.session.errorMsg;
  delete req.session.successMsg;
  next();
});
app.use(loadUser);

// ---------- Helpers ----------
function isOwner(post, user) {
  return !!user && post.author.toString() === user._id.toString();
}

function shapePost(post, currentUser) {
  post.likeCount = post.likes.length;
  post.likedByMe = !!currentUser && post.likes.some((id) => id.toString() === currentUser._id.toString());
  post.isOwner = isOwner(post, currentUser);
  return post;
}

// ---------- Auth routes ----------
app.get("/register", (req, res) => {
  if (req.user) return res.redirect("/home");
  res.render("register");
});

app.post("/register", async (req, res) => {
  try {
    const { username, email, password, role } = req.body;

    if (!username || !email || !password) {
      req.session.errorMsg = "All fields are required.";
      return res.redirect("/register");
    }

    const existing = await User.findOne({ $or: [{ username }, { email }] });
    if (existing) {
      req.session.errorMsg = "Username or email is already taken.";
      return res.redirect("/register");
    }

    const user = new User({ username, email, password, role: role || undefined });
    await user.save();

    req.session.userId = user._id;
    req.session.successMsg = `Welcome to DevSphere, ${user.username}!`;
    res.redirect("/home");
  } catch (err) {
    console.error(err);
    req.session.errorMsg = "Something went wrong while signing up.";
    res.redirect("/register");
  }
});

app.get("/login", (req, res) => {
  if (req.user) return res.redirect("/home");
  res.render("login");
});

app.post("/login", async (req, res) => {
  try {
    const { identifier, password } = req.body;
    const user = await User.findOne({
      $or: [{ username: identifier }, { email: identifier }],
    });

    if (!user || !(await user.comparePassword(password))) {
      req.session.errorMsg = "Invalid username/email or password.";
      return res.redirect("/login");
    }

    req.session.userId = user._id;
    const returnTo = req.session.returnTo;
    delete req.session.returnTo;
    req.session.successMsg = `Welcome back, ${user.username}!`;
    res.redirect(returnTo || "/home");
  } catch (err) {
    console.error(err);
    req.session.errorMsg = "Something went wrong while logging in.";
    res.redirect("/login");
  }
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/home");
  });
});

// ---------- Post routes ----------
app.get("/home", async (req, res) => {
  const postsRaw = await Post.find().sort({ createdAt: -1 }).lean();
  const posts = postsRaw.map((p) => shapePost(p, req.user));
  res.render("home", { posts });
});

app.get("/create", requireAuth, (req, res) => {
  res.render("post");
});

app.post("/create", requireAuth, async (req, res) => {
  const { title, content, tags } = req.body;

  if (!title || !content) {
    req.session.errorMsg = "Title and content are required.";
    return res.redirect("/create");
  }

  const tagList = (tags || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  await Post.create({
    author: req.user._id,
    authorName: req.user.username,
    authorRole: req.user.role,
    authorAvatar: req.user.avatar,
    title,
    content,
    tags: tagList,
  });

  res.redirect("/home");
});

app.get("/post/:id", async (req, res) => {
  const { id } = req.params;

  const postRaw = await Post.findById(id).lean();
  if (!postRaw) {
    req.session.errorMsg = "Post not found.";
    return res.redirect("/home");
  }
  const post = shapePost(postRaw, req.user);

  const comments = await Comment.find({ post: id }).sort({ createdAt: 1 }).lean();
  const commentsWithOwnership = comments.map((c) => ({
    ...c,
    isOwner: !!req.user && c.author.toString() === req.user._id.toString(),
  }));

  res.render("show", { post, comments: commentsWithOwnership });
});

app.get("/edit/:id", requireAuth, async (req, res) => {
  const { id } = req.params;
  const post = await Post.findById(id);

  if (!post) {
    req.session.errorMsg = "Post not found.";
    return res.redirect("/home");
  }
  if (!isOwner(post, req.user)) {
    req.session.errorMsg = "You can only edit your own posts.";
    return res.redirect("/post/" + id);
  }

  res.render("edit", { post });
});

app.patch("/edit/:id", requireAuth, async (req, res) => {
  const { id } = req.params;
  const post = await Post.findById(id);

  if (!post) {
    req.session.errorMsg = "Post not found.";
    return res.redirect("/home");
  }
  if (!isOwner(post, req.user)) {
    req.session.errorMsg = "You can only edit your own posts.";
    return res.redirect("/post/" + id);
  }

  post.title = req.body.title;
  post.content = req.body.content;
  post.tags = (req.body.tags || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  await post.save();
  res.redirect("/post/" + id);
});

app.delete("/delete/:id", requireAuth, async (req, res) => {
  const { id } = req.params;
  const post = await Post.findById(id);

  if (!post) {
    req.session.errorMsg = "Post not found.";
    return res.redirect("/home");
  }
  if (!isOwner(post, req.user)) {
    req.session.errorMsg = "You can only delete your own posts.";
    return res.redirect("/post/" + id);
  }

  await Post.findByIdAndDelete(id);
  await Comment.deleteMany({ post: id });

  req.session.successMsg = "Post deleted.";
  res.redirect("/home");
});

// ---------- Like routes ----------
app.post("/post/:id/like", requireAuth, async (req, res) => {
  const { id } = req.params;
  const post = await Post.findById(id);

  if (!post) {
    req.session.errorMsg = "Post not found.";
    return res.redirect("/home");
  }

  const alreadyLiked = post.likes.some((uid) => uid.toString() === req.user._id.toString());
  if (alreadyLiked) {
    post.likes.pull(req.user._id);
  } else {
    post.likes.push(req.user._id);
  }
  await post.save();

  res.redirect(req.get("Referer") || "/post/" + id);
});

// ---------- Comment routes ----------
app.post("/post/:id/comments", requireAuth, async (req, res) => {
  const { id } = req.params;
  const { content } = req.body;

  const post = await Post.findById(id);
  if (!post) {
    req.session.errorMsg = "Post not found.";
    return res.redirect("/home");
  }

  if (content && content.trim()) {
    await Comment.create({
      post: id,
      author: req.user._id,
      authorName: req.user.username,
      authorAvatar: req.user.avatar,
      content: content.trim(),
    });
  }

  res.redirect("/post/" + id + "#comments");
});

app.delete("/post/:postId/comments/:commentId", requireAuth, async (req, res) => {
  const { postId, commentId } = req.params;
  const comment = await Comment.findById(commentId);

  if (!comment) {
    return res.redirect("/post/" + postId + "#comments");
  }

  const post = await Post.findById(postId);
  const canDelete =
    comment.author.toString() === req.user._id.toString() ||
    (post && isOwner(post, req.user));

  if (!canDelete) {
    req.session.errorMsg = "You can only delete your own comments.";
    return res.redirect("/post/" + postId + "#comments");
  }

  await Comment.findByIdAndDelete(commentId);
  res.redirect("/post/" + postId + "#comments");
});

// ---------- Static pages ----------
app.get("/about", (req, res) => {
  res.render("about");
});

app.get("/", (req, res) => res.redirect("/home"));

app.listen(PORT, () => {
  console.log(`Server started on http://localhost:${PORT}`);
});
