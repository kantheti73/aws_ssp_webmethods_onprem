package com.ssp.portal.controller;

import com.ssp.portal.client.OrdersClient;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.*;

import java.util.Map;
import java.util.concurrent.CompletableFuture;

@RestController
@RequestMapping("/api/orders")
public class OrdersController {

    private final OrdersClient ordersClient;

    public OrdersController(OrdersClient ordersClient) {
        this.ordersClient = ordersClient;
    }

    /**
     * Demonstrates pass-through JWT: the same access token the SSP user presented
     * is forwarded (still cryptographically valid) to the federated APIGW, which
     * forwards it to webMethods.
     *
     * NOTE: in production, prefer a token-exchange step if downstream services
     * need a different audience or short-lived service identity (see docs/02-oauth-flow.md).
     */
    @GetMapping("/{id}")
    public CompletableFuture<ResponseEntity<Map<String, Object>>> get(
            @PathVariable String id,
            @RequestHeader(value = "traceparent", required = false) String traceparent,
            @AuthenticationPrincipal Jwt jwt) {

        String bearer = jwt.getTokenValue();
        String tp = (traceparent != null) ? traceparent : generateTraceparent();
        return ordersClient.getOrder(id, bearer, tp)
                .thenApply(ResponseEntity::ok)
                .toCompletableFuture();
    }

    private static String generateTraceparent() {
        String traceId = randomHex(32);
        String spanId = randomHex(16);
        return "00-" + traceId + "-" + spanId + "-01";
    }

    private static String randomHex(int chars) {
        byte[] bytes = new byte[chars / 2];
        new java.security.SecureRandom().nextBytes(bytes);
        StringBuilder sb = new StringBuilder(chars);
        for (byte b : bytes) sb.append(String.format("%02x", b));
        return sb.toString();
    }
}
