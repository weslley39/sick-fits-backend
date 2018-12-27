const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { randomBytes } = require('crypto');
const { promisify } = require('util');
const { transport, makeANiceEmail } = require('../mail');
const { hasPermission } = require('../utils');
const stripe = require('../stripe');

const MAX_AGE = 1000 * 60 * 60 * 24 * 365; // 1 year cookie


const mutations = {
  async createItem(parent, args, ctx, info) {
    if (!ctx.request.userId) throw new Erro('You must be logged in to do that');

    const item = await ctx.db.mutation.createItem(
      {
        data: {
          user: {
            connect: {
              id: ctx.request.userId
            }
          },
          ...args,
        },
      },
      info
    );

    console.log(item);

    return item;
  },
  updateItem(parent, args, ctx, info) {
    // first take a copu of the updates
    const updates = { ...args };
    // remote the Id from it
    delete updates.id;
    // run the update method
    return ctx.db.mutation.updateItem({
      data: updates,
      where: {
        id: args.id,
      },
    }, info)
  },
  async deleteItem(parent, args, ctx, info) {
    const where = { id: args.id };
    const item = await ctx.db.query.item({ where }, `{ id title user { id } }`);

    const owmsItem = item.user.id === ctx.request.userId;
    const hasPermissions = ctx.request.user.permissions.some(permission => {
      const validPermissions = ['ADMIN', 'ITEMDELETE'];
      return validPermissions.includes(permission);
    });

    if (!owmsItem && !hasPermission) throw new Error(`You don't have permission to do that!`);

    return ctx.db.mutation.deleteItem({ where }, info);
  },
  async signup(parent, args, ctx, info) {
    args.email = args.email.toLowerCase();
    const password = await bcrypt.hash(args.password, 10);
    const user = await ctx.db.mutation.createUser({
      data: {
        ...args,
        password,
        permissions: { set: ['USER'] },
      },
    }, info);

    const token = jwt.sign({ userId: user.id }, process.env.APP_SECRET);

    ctx.response.cookie('token', token, {
      httpOnly: true,
      maxAge: MAX_AGE
    });

    return user;
  },
  async signin(parent, { email, password }, ctx, info) {
    const user = await ctx.db.query.user({ where: { email }});
    if (!user) {
      throw new Error(`No such user found for email -> ${email}`);
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      throw new Error (`Invalid Paasword!`);
    }

    const token = jwt.sign({ userId: user.id }, process.env.APP_SECRET);

    ctx.response.cookie('token', token, {
      httpOnly: true,
      maxAge: MAX_AGE,
    });

    return user;
  },

  signout(parent, args, ctx, info) {
    ctx.response.clearCookie('token');
    return { message: 'Goodbye!' };
  },

  async requestReset(parent, args, ctx, info) {
    const user = await ctx.db.query.user({ where: { email: args.email } });

    if (!user) throw new Error(`No such user found for email ${args.email}`);

    const randomBytesPromiseified = promisify(randomBytes);
    const resetToken = (await randomBytesPromiseified(20)).toString('hex');
    const resetTokenExpiry = Date.now() + 3600000; // 1 hour from now
    const res = await ctx.db.mutation.updateUser({
      where: { email: args.email },
      data: { resetToken, resetTokenExpiry },
    });

    const mailRes = await transport.sendMail({
      from: 'wes@wesbos.com',
      to: user.email,
      subject: 'Your Password Reset Token',
      html: makeANiceEmail(`Your Password Reset Token is here!
      \n\n
      <a href="${process.env
        .FRONTEND_URL}/reset?resetToken=${resetToken}">Click Here to Reset</a>`),
    });


    return { message: 'Thanks!' };
  },
  async resetPassword(parent, { password, confirmPassword, resetToken }, ctx, info) {
    if (password !== confirmPassword) throw new Error("Yo Passwords don't match!");
    const [user] = await ctx.db.query.users({
      where: {
        resetToken,
        resetTokenExpiry_gte: Date.now() - 3600000,
      },
    });
    if (!user) throw new Error('This token is either invalid or expired!');

    const newPassword = await bcrypt.hash(password, 10);
    const updatedUser = await ctx.db.mutation.updateUser({
      where: { email: user.email },
      data: {
        password: newPassword,
        resetToken: null,
        resetTokenExpiry: null,
      },
    });
    const token = jwt.sign({ userId: updatedUser.id }, process.env.APP_SECRET);
    ctx.response.cookie('token', token, {
      httpOnly: true,
      maxAge: MAX_AGE,
    });
    return updatedUser;
  },
  async updatePermissions(parent, args, ctx, info) {
    if (!ctx.request.userId) throw new Error('You must be logged in');

    const currentUser = await ctx.db.query.user({
      where: {
        id: ctx.request.userId,
      }
    }, info);

    hasPermission(currentUser, ['ADMIN', 'PERMISSIONUPDATE']);

    return ctx.db.mutation.updateUser({
      data: {
        permissions: {
          set: args.permissions
        },
      },
      where: {
        id: args.userId,
      }
    }, info);
  },

  async addToCart(parent, args, ctx, info) {
    const { userId } = ctx.request;

    // 1. Check if the user is signed in
    if (!userId) {
      throw new Error('You must be signed in sooon!');
    }

    // 2. Query the users current cart
    const [existingCartItem] = await ctx.db.query.cartItems({
      where: {
        user: { id: userId },
        item: { id: args.id },
      },
    });

    // 3. Check if that item is already in their cart and increment by 1
    if (existingCartItem) {
      console.log('This item is already in their cart');
      return ctx.db.mutation.updateCartItem({
        where: { id: existingCartItem.id },
        data: { quantity: existingCartItem.quantity + 1 },
      }, info);
    }

    // 4. If its not, create a fresh new CartItem
    return ctx.db.mutation.createCartItem({
      data: {
        user: {
          connect: { id: userId },
        },
        item: {
          connect: { id: args.id },
        },
      },
    }, info);
  },

  async removeFromCart(parent, args, ctx, info) {
    // 1. Find the car Item
    const cartItem = await ctx.db.query.cartItem({
      where: {
        id: args.id,
      },
    }, `{ id, user { id } }`);

    // 2. Make sure we found an item
    if (!cartItem) throw new Error('No CartItem Found');

    // 3. Make sure they own that car item
    if (cartItem.user.id !== ctx.request.userId) throw new Error('Chating HUUUUH');

    // 4. Delete that cart item
    return ctx.db.mutation.deleteCartItem({
      where: {
        id: args.id,
      },
    }, info);
  },

  async createOrder(parent, args, ctx, info) {
    const { userId } = ctx.request;
    if (!userId) throw new Error('You must be signed in to complete this order.');

    const user = await ctx.db.query.user({
      where: { id: userId },
    }, `
      {
        id
        name
        email
        cart {
          id
          quantity
          item {
            title
            price
            id
            description
            image
            largeImage
          }
        }
      }
    `);

    const amount = user.cart.reduce((tally, cartItem) => tally + cartItem.item.price * cartItem.quantity, 0);

    console.log(`Going to change for a total of ${amount}`);

    const charge = await stripe.charges.create({
      amount,
      currency: 'USD',
      source: args.token
    });

    // Convert the CarItem to OrderItems
    const orderItems = user.cart.map(cartItem => {
      const orderItem = {
        ...cartItem.item,
        quantity: cartItem.quantity,
        user: { connect: { id: userId } },
      };
      delete orderItem.id;
      return orderItem;
    });
    // Create the Order
    const order = await ctx.db.mutation.createOrder({
      data: {
        total: charge.amount,
        charge: charge.id,
        items: { create: orderItems },
        user: { connect: { id: userId } },
      },
    });
    // Clean up - clear the users cart, delete cartItems
    const cartItemIds = user.cart.map(cartItem => cartItem.id);

    await ctx.db.mutation.deleteManyCartItems({
      where: { id_in: cartItemIds },
    });
    // Return the order to the client
    return order;
  }
};

module.exports = mutations;
