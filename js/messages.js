// Catálogo centralizado de textos de UI en español. Ninguna vista debe
// hardcodear copy inline (mismo patrón que foodc-caja/js/messages.js).
// R1 solo necesitaba la pantalla de PIN; R2 agrega los textos del reporte
// (report-view: KPIs, estados de día, errores, calidad de datos).

export const messages = {
  pin: {
    title: 'Ingresá el PIN de caja',
    submit: 'Entrar',
    // auth.error states, ver reportes-access spec y el state shape auth.error.
    wrongPin: 'PIN incorrecto. Intente de nuevo.',
    offline: 'Sin conexión, reintente.',
    notConfigured: 'El PIN de caja no está configurado en el servidor. Avise al administrador.',
    contract: 'No se pudo validar el PIN (versión del servidor incompatible).',
  },

  report: {
    title: 'Reporte de ventas',
    startDateLabel: 'Fecha de inicio',
    viewAction: 'Ver',
    loading: 'Cargando...',
    emptyWindow: 'No hay ventas registradas en este rango de fechas.',
    startDateInvalid: 'Fecha inválida.',

    kpis: {
      totalSales: 'Ventas totales',
      orderCount: 'Órdenes',
      avgTicket: 'Ticket promedio',
      avgTicketNoData: 'Sin datos',
    },

    // `reportes-sales-view` "Distinct Day States" — these exact three
    // labels are the requirement's own wording, kept verbatim so the
    // rendered text matches the spec's scenarios literally.
    dayState: {
      closed: 'Cerrado',
      sinCierre: 'Sin cierre',
      sinCierreNote: 'Ventas archivadas en un cierre posterior',
      pendiente: 'Pendiente de cierre',
    },

    products: {
      title: 'Productos',
      empty: 'Sin productos en este rango',
    },

    hours: {
      title: 'Distribución por hora',
    },

    // `classifyReportResult`'s status vocabulary (js/report.js), each
    // distinct per `reportes-sales-view` "Error States Map to Distinct,
    // Actionable Messages". `relock` and `ready`/`empty` never render
    // through this map (relock hands off to the PIN screen; ready/empty
    // render the results view instead).
    errors: {
      error: 'Ocurrió un error al cargar el reporte. Reintentar.',
      blocked: 'El sistema no está configurado. Avise al administrador.',
      contract: 'La versión del cliente no coincide con el servidor. Actualice la página.',
      unknown: 'Sin conexión. Reintentar.',
    },

    // Data-quality notes from `data.excluded` (design Decision 3); shown
    // alongside a ready/empty result, never as an error state.
    dataQuality: {
      duplicates: (n) => `${n} orden(es) duplicada(s) excluida(s) del total.`,
      undated: (n) => `${n} orden(es) sin fecha excluida(s) del total.`,
      invalidTotal: (n) => `${n} monto(s) inválido(s) excluido(s) del total.`,
      unparsedDetails: (n) => `${n} detalle(s) de producto no interpretado(s) (la orden sí se contó).`,
    },
  },
};
