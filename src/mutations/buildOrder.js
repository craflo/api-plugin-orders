import _ from "lodash";
import SimpleSchema from "simpl-schema";
import Random from "@reactioncommerce/random";
import ReactionError from "@reactioncommerce/reaction-error";
import buildOrderFulfillmentGroupFromInput from "../util/buildOrderFulfillmentGroupFromInput.js";
import { Order as OrderSchema, orderInputSchema, Payment as PaymentSchema, paymentInputSchema } from "../simpleSchemas.js";
import nameko from 'node-nameko-client';

var d = 30;
d = 300
const inputSchema = new SimpleSchema({
  "order": orderInputSchema,
  "payments": {
    type: Array,
    optional: true
  },
  "payments.$": paymentInputSchema
});



async function rmqPaymentsMakeOrder(order) {

  const nameko_config={
    host: process.env['RABBIT_HOST'],
    port: process.env['RABBIT_PORT'],
    login: process.env['RABBIT_USER'],
    password: process.env['RABBIT_PASSWORD']
  }

  
  nameko.connect(nameko_config).on('ready', function(rpc) {
    rpc.call('CustomerPaymentsService', 'createOrder', [order], {}, function(e, r) {
        if (e) {
            console.log('Oops! RPC error:', e);
            return 500
        } else {
            console.error('Success: Result is', r);
            return r
        }
    });
  });
}

// You can also use promises. Here's an example with promises & ES6 syntax:

/*
nameko.connect(nameko_config)
  .then(
      rpc => rpc.call('mailer', 'send_mail', ['foo@example.org', 'Hello!', 'It\'s been a lo-o-o-ong time.']);
  )
  .then(
      result => console.log('Success: Result is', result);
  )
  .catch(
      error => console.error('Oops! RPC error:', error.stack);
  );
}
*/

/**
 * @method buildOrder
 * @summary builds an order, for the payment gateway
 * @param {Object} context - an object containing the per-request state
 * @param {Object} input - Necessary input. See SimpleSchema
 * @returns {Promise<Object>} Object with `order` property containing the created order
 */
export default async function buildOrder(context, input) {
  const cleanedInput = inputSchema.clean(input); // add default values and such
  inputSchema.validate(cleanedInput);

  const { order: orderInput, payments: paymentsInput } = cleanedInput;
  const {
    billingAddress,
    cartId,
    currencyCode,
    customFields: customFieldsFromClient,
    email,
    fulfillmentGroups,
    ordererPreferredLanguage,
    shopId
  } = orderInput;
  const { accountId, appEvents, collections, getFunctionsOfType, userId } = context;
  const { Orders, Cart } = collections;

  const shop = await context.queries.shopById(context, shopId);
  if (!shop) throw new ReactionError("not-found", "Shop not found");

  if (!userId && !shop.allowGuestCheckout) {
    throw new ReactionError("access-denied", "Guest checkout not allowed");
  }

  let cart;
  if (cartId) {
    cart = await Cart.findOne({ _id: cartId });
    if (!cart) {
      throw new ReactionError("not-found", "Cart not found while trying to place order");
    }
  }


  // We are mixing concerns a bit here for now. This is for backwards compatibility with current
  // discount codes feature. We are planning to revamp discounts soon, but until then, we'll look up
  // any discounts on the related cart here.
  let discounts = [];
  let discountTotal = 0;
  if (cart) {
    const discountsResult = await context.queries.getDiscountsTotalForCart(context, cart);
    ({ discounts } = discountsResult);
    discountTotal = discountsResult.total;
  }

  // Create array for surcharges to apply to order, if applicable
  // Array is populated inside `fulfillmentGroups.map()`
  const orderSurcharges = [];

  // Create orderId
  const orderId = Random.id();


  // Add more props to each fulfillment group, and validate/build the items in each group
  let orderTotal = 0;
  let shippingAddressForPayments = null;
  const finalFulfillmentGroups = await Promise.all(fulfillmentGroups.map(async (inputGroup) => {
    const { group, groupSurcharges } = await buildOrderFulfillmentGroupFromInput(context, {
      accountId,
      billingAddress,
      cartId,
      currencyCode,
      discountTotal,
      inputGroup,
      orderId
    });

    // We save off the first shipping address found, for passing to payment services. They use this
    // for fraud detection.
    if (group.address && !shippingAddressForPayments) shippingAddressForPayments = group.address;

    // Push all group surcharges to overall order surcharge array.
    // Currently, we do not save surcharges per group
    orderSurcharges.push(...groupSurcharges);

    // Add the group total to the order total
    orderTotal += group.invoice.total;

    return group;
  }));

  const PaymentServiceOrder = await rmqPaymentsMakeOrder(order);
  await appEvents.emit("afterPaymentOrderBuilt", {
    createdBy: userId,
    accountId,
    billingAddress,
    context,
    currencyCode,
    email,
    orderTotal,
    paymentsInput,
    shippingAddress: shippingAddressForPayments,
    shop
  });

  return {
    PaymentServiceOrder: PaymentServiceOrder,
    // GraphQL response gets the raw token
    token: fullToken && fullToken.token
  };
}
