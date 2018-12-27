const { forwardTo } = require('prisma-binding');
const { hasPermission } = require('../utils');


const Query = {
  items: forwardTo('db'),
  item: forwardTo('db'),
  itemsConnection: forwardTo('db'),
  me(parent, args, ctx, info) {
    let user = null;

    if (ctx.request.userId) {
      user = ctx.db.query.user({
        where: { id: ctx.request.userId },
      }, info)
    };

    return user;
  },

  async users(parent, args, ctx, info) {
    if (!ctx.request.userId) throw new Error('You must be logged in!');

    console.log(ctx.request.userId);

    hasPermission(ctx.request.user, ['ADMIN', 'PERMISSIONUPDATE']);

    return ctx.db.query.users({}, info);
  },

  async order(parent, args, ctx, info) {
    if (!ctx.request.userId) throw new Error('You arent logged in!');

    const order = await ctx.db.query.order({
      where: { id: args.id },
    }, info);

    const ownsOder = order.user.id === ctx.request.userId;
    const hasPermissionToSeeOrder = ctx.request.user.permissions.includes('ADMIN');

    if (!ownsOder && !hasPermissionToSeeOrder) throw new Error('You cant see this ma friend');

    return order;
  },

  async orders(parent, args, ctx, info) {
    const { userId } = ctx.request;
    if (!userId) throw new Error('You must be signed in!');

    return ctx.db.query.orders(
      {
        where: { user: { id: userId } },
      },
      info
    );
  },
  // async items(parent, args, ctx, info) {
  //   const items = await ctx.db.query.items();
  //   return items;
  // }
};

module.exports = Query;
