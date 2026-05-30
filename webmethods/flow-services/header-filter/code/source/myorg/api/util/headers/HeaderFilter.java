package myorg.api.util.headers;

import com.wm.app.b2b.server.Service;
import com.wm.app.b2b.server.ServiceException;
import com.wm.data.IData;
import com.wm.data.IDataCursor;
import com.wm.data.IDataFactory;
import com.wm.data.IDataUtil;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * HeaderFilter — strips any HTTP header whose name is not in an allowlist.
 *
 * Tested against webMethods Integration Server / API Gateway 10.15.
 *
 * <p>The allowlist defaults to the six headers the SSP federation needs
 * downstream (Authorization, Content-Type, Accept, X-Correlation-ID,
 * X-Request-ID, SOAPAction). Callers can override per invocation.
 *
 * <p>Header name comparison is case-insensitive by default — HTTP/1.1 §3.2
 * makes header names case-insensitive, and AWS API Gateway will lowercase
 * many of them before they reach webMethods.
 *
 * <p>This service is pure: it does NOT mutate the transport context. Use the
 * output {@code filteredHeaders} as input to {@code pub.client:http} (for
 * outbound calls) or feed it to the next step of your Flow.
 *
 * <h3>Pipeline contract</h3>
 *
 * <pre>
 * Inputs:
 *   headers           (IData)            REQUIRED  Source headers (typically
 *                                                  transport/http/requestHdrs)
 *   allowedNames      (String[])         OPTIONAL  Override default allowlist
 *   caseSensitive     (String)           OPTIONAL  "true"/"false", default "false"
 *
 * Outputs:
 *   filteredHeaders   (IData)            Headers that passed the allowlist
 *   removedNames      (String[])         Names that were dropped (for logging)
 *   removedCount      (String)
 *   keptCount         (String)
 * </pre>
 */
public final class HeaderFilter {

    /** Default allowlist — matches docs/02-oauth-flow.md token-forwarding contract. */
    private static final Set<String> DEFAULT_ALLOWED;
    static {
        Set<String> s = new HashSet<>();
        s.add("authorization");
        s.add("content-type");
        s.add("accept");
        s.add("x-correlation-id");
        s.add("x-request-id");
        s.add("soapaction");
        DEFAULT_ALLOWED = s;
    }

    private HeaderFilter() {}

    public static final void filterAllowed(IData pipeline) throws ServiceException {
        IDataCursor cursor = pipeline.getCursor();
        try {
            // ---------- Inputs ----------
            IData headers = IDataUtil.getIData(cursor, "headers");
            String[] allowedArr = IDataUtil.getStringArray(cursor, "allowedNames");
            String caseSensitiveStr = IDataUtil.getString(cursor, "caseSensitive");

            boolean caseSensitive = "true".equalsIgnoreCase(caseSensitiveStr);

            Set<String> allowed;
            if (allowedArr != null && allowedArr.length > 0) {
                allowed = new HashSet<>();
                for (String n : allowedArr) {
                    if (n == null) continue;
                    allowed.add(caseSensitive ? n : n.toLowerCase(Locale.ROOT));
                }
            } else {
                allowed = DEFAULT_ALLOWED; // already lowercased
            }

            if (headers == null) {
                throw new ServiceException(
                    "HeaderFilter.filterAllowed: required input 'headers' is null. "
                  + "Map transport/http/requestHdrs from pub.flow:getTransportInfo.");
            }

            // ---------- Filter ----------
            IData filtered = IDataFactory.create();
            IDataCursor outCursor = filtered.getCursor();
            List<String> removed = new ArrayList<>();
            int kept = 0;

            IDataCursor inCursor = headers.getCursor();
            try {
                while (inCursor.next()) {
                    String name = inCursor.getKey();
                    Object value = inCursor.getValue();
                    String lookup = name == null ? "" :
                            (caseSensitive ? name : name.toLowerCase(Locale.ROOT));
                    if (allowed.contains(lookup)) {
                        outCursor.insertAfter(name, value);
                        kept++;
                    } else {
                        removed.add(name);
                    }
                }
            } finally {
                inCursor.destroy();
                outCursor.destroy();
            }

            // ---------- Outputs ----------
            IDataUtil.put(cursor, "filteredHeaders", filtered);
            IDataUtil.put(cursor, "removedNames", removed.toArray(new String[0]));
            IDataUtil.put(cursor, "removedCount", String.valueOf(removed.size()));
            IDataUtil.put(cursor, "keptCount", String.valueOf(kept));
        } finally {
            cursor.destroy();
        }
    }

    /**
     * Convenience wrapper: reads transport/http/requestHdrs itself by calling
     * pub.flow:getTransportInfo, then delegates to filterAllowed.
     *
     * <p>Use this when you're inside an IS service handling an inbound HTTP
     * request and don't want to wire the pub.flow:getTransportInfo call in
     * your own Flow.
     *
     * <p>Pipeline contract is identical to {@link #filterAllowed(IData)},
     * except {@code headers} is read from the transport context.
     */
    public static final void filterAllowedFromTransport(IData pipeline) throws ServiceException {
        IDataCursor cursor = pipeline.getCursor();
        try {
            // Pull transport headers.
            IData transportOut;
            try {
                transportOut = Service.doInvoke("pub.flow", "getTransportInfo", IDataFactory.create());
            } catch (Exception e) {
                throw new ServiceException(
                    "pub.flow:getTransportInfo invocation failed: " + e.getMessage());
            }

            IData requestHdrs = null;
            IDataCursor tCursor = transportOut.getCursor();
            try {
                IData transport = IDataUtil.getIData(tCursor, "transport");
                if (transport != null) {
                    IDataCursor tcc = transport.getCursor();
                    try {
                        IData http = IDataUtil.getIData(tcc, "http");
                        if (http != null) {
                            IDataCursor hcc = http.getCursor();
                            try {
                                requestHdrs = IDataUtil.getIData(hcc, "requestHdrs");
                            } finally {
                                hcc.destroy();
                            }
                        }
                    } finally {
                        tcc.destroy();
                    }
                }
            } finally {
                tCursor.destroy();
            }

            if (requestHdrs == null) requestHdrs = IDataFactory.create(); // no headers context

            // Inject as 'headers' input and reuse filterAllowed's logic.
            IDataUtil.put(cursor, "headers", requestHdrs);
        } finally {
            cursor.destroy();
        }

        filterAllowed(pipeline);
    }
}
