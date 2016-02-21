// #include <stddef.h>
// #include <stdint.h>
// #include <stdlib.h>
// #include <string.h>
// #include "api.h"
#ifndef EBML_BUFFER_H
#define EBML_BUFFER_H
#define EBML_BUFFER_INCREMENT 4096


static const struct ebml_buffer     EBML_BUFFER_EMPTY     = {NULL, 0};
static const struct ebml_buffer_dyn EBML_BUFFER_EMPTY_DYN = {NULL, 0, 0, 0};


static inline struct ebml_buffer ebml_buffer_shift(struct ebml_buffer b, size_t shift)
{
    return (struct ebml_buffer) { b.data + shift, b.size - shift };
}


static inline struct ebml_buffer ebml_buffer_static(struct ebml_buffer_dyn *b)
{
    return (struct ebml_buffer) { b->data, b->size };
}


static inline void ebml_buffer_dyn_clear(struct ebml_buffer_dyn *b)
{
    free(b->data - b->offset);
    *b = EBML_BUFFER_EMPTY_DYN;
}


static inline void ebml_buffer_dyn_shift(struct ebml_buffer_dyn *b, size_t shift)
{
    b->data   += shift;
    b->size   -= shift;
    b->offset += shift;
}


static int ebml_buffer_dyn_concat(struct ebml_buffer_dyn *a, struct ebml_buffer b)
{
    if (b.data == NULL)
        return 0;

    if (a->offset) {
        memmove(a->data - a->offset, a->data, a->size);
        a->data    -= a->offset;
        a->reserve += a->offset;
        a->offset   = 0;
    }

    if (b.size <= a->reserve) {
        memcpy(a->data + a->size, b.data, b.size);
        a->size    += b.size;
        a->reserve -= b.size;
        return 0;
    }

    size_t new_size = (a->size + b.size + EBML_BUFFER_INCREMENT - 1) / EBML_BUFFER_INCREMENT
                                                                     * EBML_BUFFER_INCREMENT;
    uint8_t *m = (uint8_t *) malloc(new_size);

    if (m == NULL)
        return -1;

    if (a->data != NULL)
        memcpy(m, a->data, a->size);

    memcpy(m + a->size, b.data, b.size);
    free(a->data);
    a->data    = m;
    a->size   += b.size;
    a->reserve = new_size - a->size;
    return 0;
}


#endif
