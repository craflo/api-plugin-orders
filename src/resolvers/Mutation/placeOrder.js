import {
  decodeCartOpaqueId,
  decodeFulfillmentMethodOpaqueId,
  decodeOrderItemsOpaqueIds,
  decodeShopOpaqueId
} from "../../xforms/id.js";
import nameko from 'node-nameko-client';

/**
 * @name Mutation/placeOrder
 * @method
 * @memberof Payments/GraphQL
 * @summary resolver for the placeOrder GraphQL mutation
 * @param {Object} parentResult - unused
 * @param {Object} args.input - an object of all mutation arguments that were sent by the client
 * @param {Object} args.input.order - The order input
 * @param {Object[]} args.input.payments - Payment info
 * @param {String} [args.input.clientMutationId] - An optional string identifying the mutation call
 * @param {Object} context - an object containing the per-request state
 * @returns {Promise<Object>} PlaceOrderPayload
 */


async function rmqOrderManoeuvre(order) {

  const nameko_config={
    host: process.env['RABBIT_HOST'],
    port: process.env['RABBIT_PORT'],
    login: process.env['RABBIT_USER'],
    password: process.env['RABBIT_PASSWORD']
  }
  console.log(nameko_config)
  
  let rmq_result = false
  try {
    let rpc = await nameko.connect(nameko_config);
    console.log(rpc);
    rmq_result  = await rpc.call('OrderManoeuvreService', 'placeOrder', [order], {});
  }
  catch (error ) {
    console.error('oops, something went wrong!', error);
  }
  console.error("Successfully triggered OrderManoeuvreService", rmq_result)
  return rmq_result
}


export default async function placeOrder(parentResult, { input }, context) {
  const { clientMutationId = null, order, payments, payments_order_id } = input;
  const { cartId: opaqueCartId, fulfillmentGroups, shopId: opaqueShopId } = order;

  const cartId = opaqueCartId ? decodeCartOpaqueId(opaqueCartId) : null;
  const shopId = decodeShopOpaqueId(opaqueShopId);

  const transformedFulfillmentGroups = fulfillmentGroups.map((group) => ({
    ...group,
    items: decodeOrderItemsOpaqueIds(group.items),
    selectedFulfillmentMethodId: decodeFulfillmentMethodOpaqueId(group.selectedFulfillmentMethodId),
    shopId: decodeShopOpaqueId(group.shopId)
  }));

  const { orders, token } = await context.mutations.placeOrder(context, {
    order: {
      payments_order_id: payments_order_id, 
      ...order,
      cartId,
      fulfillmentGroups: transformedFulfillmentGroups,
      shopId
    },
    payments
  });
  
  const OrderManoeuvreService = await rmqOrderManoeuvre(orders)
  console.log(OrderManoeuvreService, "OrderManoeuvreService")
  
  return {
    clientMutationId,
    orders,
    token
  };
}
